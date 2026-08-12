import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { parseSearchEngines } from "../../shared/contracts.js"
import type { AuthService } from "../services/auth.js"
import type { SearchService } from "../services/search.js"

const searchSchema = z.object({ q: z.string().trim().min(1).max(500), page: z.number().int().min(1).max(20).default(1) })

export function registerSearchRoutes(app: FastifyInstance, auth: AuthService, search: SearchService) {
  app.post("/api/search", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async request => {
    const context = auth.requireRequest(request)
    auth.verifyCsrf(request, context)
    const body = searchSchema.parse(request.body)
    return search.search(body.q, body.page, context.user.safeSearch as 0 | 1 | 2, parseSearchEngines(context.user.searchEngines))
  })
}
