import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AuthService } from "../services/auth.js"
import { egressSettingsSchema, type SettingsService } from "../services/settings.js"

const userIdSchema = z.object({ userId: z.string().uuid() })

export function registerAdminRoutes(app: FastifyInstance, auth: AuthService, settings: SettingsService, getWorkerHealth: () => Promise<unknown>) {
  app.get("/api/admin/users", async request => {
    auth.requireOwner(request)
    return { users: auth.listUsers() }
  })

  app.get("/api/admin/invites", async request => {
    auth.requireOwner(request)
    return { invites: auth.listInvites() }
  })

  app.post("/api/admin/invites", { config: { rateLimit: { max: 20, timeWindow: "1 hour" } } }, async request => {
    const context = auth.requireOwner(request)
    auth.verifyCsrf(request, context)
    return auth.createInvite(context)
  })

  app.post("/api/admin/users/:userId/approve", async request => {
    const context = auth.requireOwner(request)
    auth.verifyCsrf(request, context)
    const params = userIdSchema.parse(request.params)
    auth.approveUser(context, params.userId)
    return { approved: true }
  })

  app.post("/api/admin/users/:userId/reject", async request => {
    const context = auth.requireOwner(request)
    auth.verifyCsrf(request, context)
    const params = userIdSchema.parse(request.params)
    auth.rejectUser(context, params.userId)
    return { rejected: true }
  })

  app.post("/api/admin/users/:userId/status", async request => {
    const context = auth.requireOwner(request)
    auth.verifyCsrf(request, context)
    const params = userIdSchema.parse(request.params)
    const body = z.object({ status: z.enum(["active", "disabled"]) }).parse(request.body)
    auth.setUserStatus(context, params.userId, body.status)
    return { updated: true }
  })

  app.delete("/api/admin/users/:userId", async request => {
    const context = auth.requireOwner(request)
    auth.verifyCsrf(request, context)
    const params = userIdSchema.parse(request.params)
    auth.removeUser(context, params.userId)
    return { removed: true }
  })

  app.post("/api/admin/users/:userId/password-reset", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async request => {
    const context = auth.requireOwner(request)
    auth.verifyCsrf(request, context)
    const params = userIdSchema.parse(request.params)
    return auth.createPasswordReset(context, params.userId)
  })

  app.get("/api/admin/health", async request => {
    auth.requireOwner(request)
    return { workers: await getWorkerHealth(), network: await settings.diagnostics(), checkedAt: Date.now() }
  })

  app.get("/api/admin/network", async request => {
    auth.requireOwner(request)
    return settings.diagnostics()
  })

  app.post("/api/admin/network", async request => {
    const context = auth.requireOwner(request)
    auth.verifyCsrf(request, context)
    return { settings: settings.write(egressSettingsSchema.parse(request.body)) }
  })
}
