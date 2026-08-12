import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import Fastify from "fastify"
import cookie from "@fastify/cookie"
import helmet from "@fastify/helmet"
import multipart from "@fastify/multipart"
import rateLimit from "@fastify/rate-limit"
import staticFiles from "@fastify/static"
import { loadConfig } from "./config.js"
import { createDatabase } from "./db/index.js"
import { registerAdminRoutes } from "./routes/admin.js"
import { registerAuthRoutes } from "./routes/auth.js"
import { registerPrivacyRoutes } from "./routes/privacy.js"
import { registerSearchRoutes } from "./routes/search.js"
import { registerViewerRoutes } from "./routes/viewer.js"
import { AuthService } from "./services/auth.js"
import { PrivacyService } from "./services/privacy.js"
import { RealtimeService } from "./services/realtime.js"
import { SearchService } from "./services/search.js"
import { SettingsService } from "./services/settings.js"
import { ViewerService } from "./services/viewer.js"
import { ViewerProxy } from "./services/viewer-proxy.js"

export async function buildServer() {
  const config = loadConfig()
  const database = createDatabase(config)
  const app = Fastify({
    trustProxy: config.trustProxy,
    logger: {
      level: config.environment === "production" ? "info" : "warn",
      redact: {
        paths: ["req.headers.cookie", "req.headers.authorization", "req.headers.x-csrf-token", "res.headers.set-cookie", "body", "query", "params"],
        censor: "[redacted]"
      }
    },
    bodyLimit: config.maxUploadBytes + 1048576
  })
  await app.register(cookie)
  await app.register(rateLimit, { global: false, hook: "preHandler" })
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1, fields: 8 } })
  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'"],
        connectSrc: ["'self'", "ws:", "wss:"],
        frameSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
        upgradeInsecureRequests: config.secureCookies ? [] : null
      }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "same-origin" },
    referrerPolicy: { policy: "no-referrer" },
    hsts: config.secureCookies ? { maxAge: 31536000, includeSubDomains: false, preload: false } : false
  })

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin
    if (origin && request.method !== "GET" && request.method !== "HEAD" && !config.allowedOrigins.has(origin)) {
      return reply.status(403).send({ code: "ORIGIN_INVALID", message: "The request came from an untrusted origin.", action: "Use the MrowSearch application page." })
    }
    reply.header("cache-control", request.url.startsWith("/api/") ? "no-store" : "private, max-age=0, must-revalidate")
  })

  const auth = new AuthService(database.db, config)
  const search = new SearchService(config)
  const privacy = new PrivacyService(database.db)
  const settings = new SettingsService(config)
  const viewer = new ViewerService(config, database.db)
  const viewerProxy = new ViewerProxy(auth, viewer, config)
  const realtime = new RealtimeService(auth, viewer, viewerProxy, config)

  registerAuthRoutes(app, auth, config, userId => viewer.clear(userId, false))
  registerSearchRoutes(app, auth, search)
  registerPrivacyRoutes(app, auth, privacy, (userId, full) => viewer.clear(userId, full), (userId, request) => viewer.clearData(userId, request))
  registerViewerRoutes(app, auth, viewer, config)
  registerAdminRoutes(app, auth, settings, () => viewer.health())

  app.get("/health/live", async () => ({ status: "ok" }))
  app.get("/health/ready", async (_request, reply) => {
    const workers = await viewer.health()
    const ready = workers.some(worker => worker.ready)
    return reply.status(ready || config.environment !== "production" ? 200 : 503).send({ status: ready ? "ready" : "degraded", workers: workers.filter(worker => worker.ready).length })
  })

  app.all("/api/viewer/kasm/*", async (request, reply) => viewerProxy.http(request, reply))
  app.all("/api/viewer/kasm", async (request, reply) => viewerProxy.http(request, reply))

  const currentDirectory = dirname(fileURLToPath(import.meta.url))
  const clientDirectory = join(currentDirectory, "../client")
  if (existsSync(clientDirectory)) {
    await app.register(staticFiles, { root: clientDirectory, wildcard: false, immutable: true, maxAge: "1 year" })
    app.get("/*", async (_request, reply) => reply.sendFile("index.html", { maxAge: 0, immutable: false }))
  } else {
    app.get("/", async (_request, reply) => reply.type("text/html").send("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>MrowSearch</title></head><body><p>The web application build is not available.</p></body></html>"))
  }

  app.server.on("upgrade", (request, socket, head) => realtime.handleUpgrade(request, socket, head))

  const cleanupTimer = setInterval(() => auth.cleanup(), 60000)
  cleanupTimer.unref()
  app.addHook("onClose", async () => {
    clearInterval(cleanupTimer)
    await viewer.close()
    database.sqlite.close()
  })

  return { app, config }
}

async function start() {
  const { app, config } = await buildServer()
  await app.listen({ host: config.host, port: config.port })
}

if (process.env.NODE_ENV !== "test") {
  void start()
}
