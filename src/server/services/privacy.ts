import { and, eq, gte } from "drizzle-orm"
import type { ClearDataRequest, ViewerPreferences } from "../../shared/contracts.js"
import type { AppDatabase } from "../db/index.js"
import { persistentStorage, sitePermissions, users } from "../db/schema.js"
import type { AuthContext } from "./auth.js"

export class PrivacyService {
  constructor(private readonly db: AppDatabase) {}

  updatePreferences(context: AuthContext, preferences: ViewerPreferences) {
    this.db.update(users).set({ ...preferences, searchEngines: JSON.stringify(preferences.searchEngines) }).where(eq(users.id, context.user.id)).run()
  }

  clear(context: AuthContext, request: ClearDataRequest) {
    const threshold = this.getThreshold(request.range)
    if (request.dataTypes.includes("permissions")) {
      const predicate = threshold === 0 ? eq(sitePermissions.userId, context.user.id) : and(eq(sitePermissions.userId, context.user.id), gte(sitePermissions.lastUsedAt, threshold))
      this.db.delete(sitePermissions).where(predicate).run()
    }
    if (request.dataTypes.some(type => ["cookies", "storage", "form-state"].includes(type))) {
      const predicate = threshold === 0 ? eq(persistentStorage.userId, context.user.id) : and(eq(persistentStorage.userId, context.user.id), gte(persistentStorage.updatedAt, threshold))
      this.db.delete(persistentStorage).where(predicate).run()
    }
  }

  private getThreshold(range: ClearDataRequest["range"]) {
    if (range === "all") {
      return 0
    }
    if (range === "hour") {
      return Date.now() - 3600000
    }
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  }
}
