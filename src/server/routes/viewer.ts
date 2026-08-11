import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { ViewerCommand } from "../../shared/contracts.js"
import type { AppConfig } from "../config.js"
import { ApiFault } from "../lib/errors.js"
import type { AuthService } from "../services/auth.js"
import type { ViewerService } from "../services/viewer.js"

export function registerViewerRoutes(app: FastifyInstance, auth: AuthService, viewer: ViewerService, config: AppConfig) {
  app.post("/api/viewer/session", async request => {
    const context = auth.requireRequest(request)
    auth.verifyCsrf(request, context)
    return viewer.create(context)
  })

  app.get("/api/viewer/session", async request => {
    const context = auth.requireRequest(request)
    return { snapshot: viewer.get(context.user.id) }
  })

  app.delete("/api/viewer/session", async request => {
    const context = auth.requireRequest(request)
    auth.verifyCsrf(request, context)
    await viewer.clear(context.user.id, false)
    return { closed: true }
  })

  app.post("/api/viewer/command", async request => {
    const context = auth.requireRequest(request)
    auth.verifyCsrf(request, context)
    return viewer.command(context, request.body as ViewerCommand)
  })

  app.post("/api/viewer/uploads", async request => {
    const context = auth.requireRequest(request)
    auth.verifyCsrf(request, context)
    const file = await request.file({ limits: { fileSize: config.maxUploadBytes, files: 1 } })
    if (!file) {
      throw new ApiFault(400, { code: "UPLOAD_MISSING", message: "No file was selected.", action: "Choose a file and try again." })
    }
    const tabField = file.fields.tabId
    const firstTabField = Array.isArray(tabField) ? tabField[0] : tabField
    const tabValue = firstTabField?.type === "field" ? firstTabField.value : undefined
    const tabId = z.string().uuid().parse(tabValue)
    const data = await file.toBuffer()
    return viewer.upload(context, tabId, file.filename, file.mimetype, data)
  })

  app.get("/api/viewer/downloads/:fileId", async (request, reply) => {
    const context = auth.requireRequest(request)
    const params = z.object({ fileId: z.string().uuid() }).parse(request.params)
    const file = await viewer.download(context, params.fileId)
    reply.header("cache-control", "no-store")
    reply.header("content-type", String(file.headers["content-type"] ?? "application/octet-stream"))
    reply.header("content-disposition", String(file.headers["content-disposition"] ?? "attachment"))
    reply.header("content-length", String(file.headers["content-length"] ?? "0"))
    return reply.send(file)
  })

  app.get("/api/viewer/audio", async (request, reply) => {
    const context = auth.requireRequest(request)
    const query = z.object({ token: z.string() }).parse(request.query)
    if (!auth.verifySocketToken(query.token, context)) {
      throw new ApiFault(401, { code: "AUDIO_TOKEN_INVALID", message: "The audio connection token is invalid or expired.", action: "Reload the private viewer and try again." })
    }
    const stream = await viewer.audio(context)
    reply.header("cache-control", "no-store")
    reply.header("content-type", "audio/webm; codecs=opus")
    return reply.send(stream)
  })
}
