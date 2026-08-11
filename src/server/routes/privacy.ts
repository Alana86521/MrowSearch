import type { FastifyInstance } from "fastify"
import { clearDataRequestSchema, viewerPreferencesSchema } from "../../shared/contracts.js"
import type { AuthService } from "../services/auth.js"
import type { PrivacyService } from "../services/privacy.js"

export function registerPrivacyRoutes(app: FastifyInstance, auth: AuthService, privacy: PrivacyService, clearViewer: (userId: string, full: boolean) => Promise<void>, clearViewerData: (userId: string, request: ReturnType<typeof clearDataRequestSchema.parse>) => Promise<void>) {
  app.put("/api/settings/viewer", async request => {
    const context = auth.requireRequest(request)
    auth.verifyCsrf(request, context)
    const preferences = viewerPreferencesSchema.parse(request.body)
    privacy.updatePreferences(context, preferences)
    return { saved: true }
  })

  app.post("/api/privacy/clear", async request => {
    const context = auth.requireRequest(request)
    auth.verifyCsrf(request, context)
    const body = clearDataRequestSchema.parse(request.body)
    privacy.clear(context, body)
    await clearViewerData(context.user.id, body)
    return { cleared: true }
  })

  app.post("/api/privacy/clear-session", async request => {
    const context = auth.requireRequest(request)
    auth.verifyCsrf(request, context)
    await clearViewer(context.user.id, false)
    return { cleared: true }
  })
}
