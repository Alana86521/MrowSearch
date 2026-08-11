import type { FastifyInstance, FastifyReply } from "fastify"
import QRCode from "qrcode"
import { z } from "zod"
import type { AppConfig } from "../config.js"
import { ApiFault } from "../lib/errors.js"
import type { AuthService } from "../services/auth.js"

const credentialSchema = z.object({ username: z.string(), password: z.string() })
const setupSchema = credentialSchema.extend({ setupToken: z.string() })
const inviteRegistrationSchema = credentialSchema.extend({ code: z.string() })
const totpSchema = z.object({ challengeToken: z.string(), code: z.string() })
const resetSchema = z.object({ code: z.string(), password: z.string() })

export function registerAuthRoutes(app: FastifyInstance, auth: AuthService, config: AppConfig, onLogout: (userId: string) => Promise<void>) {
  const cookieOptions = {
    path: "/",
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "strict" as const,
    maxAge: config.absoluteSessionSeconds
  }

  const setSession = (reply: FastifyReply, sessionToken: string) => {
    reply.setCookie(config.cookieName, sessionToken, cookieOptions)
  }

  app.get("/api/auth/session", async request => {
    const context = auth.authenticateRequest(request)
    if (!context) {
      return { setupRequired: auth.setupRequired(), authenticated: false }
    }
    const csrfToken = auth.rotateCsrf(context)
    return { setupRequired: false, authenticated: true, user: auth.asSessionUser(context.user), csrfToken }
  })

  app.post("/api/auth/setup", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const body = setupSchema.parse(request.body)
    const session = await auth.setupOwner(body.setupToken, body.username, body.password, request.headers["user-agent"] ?? "unknown")
    setSession(reply, session.sessionToken)
    return { authenticated: true, csrfToken: session.csrfToken }
  })

  app.post("/api/auth/login", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const body = credentialSchema.parse(request.body)
    const result = await auth.login(body.username, body.password, request.headers["user-agent"] ?? "unknown")
    if (result.requiresTotp) {
      return result
    }
    setSession(reply, result.sessionToken)
    return { authenticated: true, csrfToken: result.csrfToken, requiresTotp: false }
  })

  app.post("/api/auth/totp/complete", { config: { rateLimit: { max: 5, timeWindow: "5 minutes" } } }, async (request, reply) => {
    const body = totpSchema.parse(request.body)
    const session = auth.completeTotp(body.challengeToken, body.code, request.headers["user-agent"] ?? "unknown")
    setSession(reply, session.sessionToken)
    return { authenticated: true, csrfToken: session.csrfToken }
  })

  app.post("/api/auth/recovery/complete", { config: { rateLimit: { max: 5, timeWindow: "5 minutes" } } }, async (request, reply) => {
    const body = totpSchema.parse(request.body)
    const session = auth.completeRecovery(body.challengeToken, body.code, request.headers["user-agent"] ?? "unknown")
    setSession(reply, session.sessionToken)
    return { authenticated: true, csrfToken: session.csrfToken }
  })

  app.post("/api/auth/register-invite", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async request => {
    const body = inviteRegistrationSchema.parse(request.body)
    return auth.registerInvite(body.code, body.username, body.password)
  })

  app.post("/api/auth/password-reset", { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } }, async request => {
    const body = resetSchema.parse(request.body)
    await auth.completePasswordReset(body.code, body.password)
    return { reset: true }
  })

  app.post("/api/auth/socket-token", async request => {
    const context = auth.requireRequest(request)
    auth.verifyCsrf(request, context)
    return { token: auth.createSocketToken(context) }
  })

  app.post("/api/auth/totp/start", { config: { rateLimit: { max: 3, timeWindow: "1 hour" } } }, async request => {
    const context = auth.requireRequest(request)
    auth.verifyCsrf(request, context)
    const setup = auth.startTotp(context)
    const qrCode = await QRCode.toDataURL(setup.uri, { width: 240, margin: 1, color: { dark: "#F4F4F5", light: "#17171A" } })
    return { ...setup, qrCode }
  })

  app.post("/api/auth/totp/confirm", { config: { rateLimit: { max: 5, timeWindow: "5 minutes" } } }, async request => {
    const context = auth.requireRequest(request)
    auth.verifyCsrf(request, context)
    const body = z.object({ code: z.string() }).parse(request.body)
    return { recoveryCodes: auth.confirmTotp(context, body.code) }
  })

  app.post("/api/auth/logout", async (request, reply) => {
    const context = auth.requireRequest(request)
    auth.verifyCsrf(request, context)
    await onLogout(context.user.id)
    auth.destroySession(context)
    reply.clearCookie(config.cookieName, { path: "/", secure: config.secureCookies, sameSite: "strict" })
    reply.header("Clear-Site-Data", '"cache", "cookies", "storage"')
    return { signedOut: true }
  })

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiFault) {
      return reply.status(error.statusCode).send(error.body)
    }
    if (error instanceof z.ZodError) {
      const fieldErrors = Object.fromEntries(error.issues.map(issue => [issue.path.join("."), issue.message]))
      return reply.status(400).send({ code: "INVALID_REQUEST", message: "One or more values are invalid.", action: "Correct the marked values and try again.", fieldErrors })
    }
    const statusCode = error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 0
    if (statusCode === 429) {
      return reply.status(429).send({ code: "RATE_LIMITED", message: "Too many requests were made in a short time.", action: "Wait before trying again." })
    }
    if (statusCode === 413) {
      return reply.status(413).send({ code: "REQUEST_TOO_LARGE", message: "The request is larger than the allowed limit.", action: "Choose a smaller file or reduce the request size." })
    }
    if (statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send({ code: "INVALID_REQUEST", message: "The request format is invalid.", action: "Check the submitted values and try again." })
    }
    const failure = error instanceof Error ? error : new Error("Unknown request failure")
    request.log.error({ err: { name: failure.name, message: failure.message } }, "request-failed")
    return reply.status(500).send({ code: "REQUEST_FAILED", message: "MrowSearch could not complete the request.", action: "Try again. If the failure continues, ask the owner to check service health." })
  })
}
