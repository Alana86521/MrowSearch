import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["owner", "user"] }).notNull(),
  status: text("status", { enum: ["pending", "active", "disabled"] }).notNull(),
  totpSecret: text("totp_secret"),
  totpEnabled: integer("totp_enabled", { mode: "boolean" }).notNull().default(false),
  safeSearch: integer("safe_search").notNull().default(1),
  searchEngines: text("search_engines").notNull().default('["duckduckgo","bing","mojeek","qwant","yahoo","mwmbl","wiby","wikipedia"]'),
  privacyMode: text("privacy_mode", { enum: ["ephemeral", "session", "persistent"] }).notNull().default("session"),
  historyMode: text("history_mode", { enum: ["never", "session"] }).notNull().default("session"),
  trackingLevel: text("tracking_level", { enum: ["off", "standard", "strict"] }).notNull().default("standard"),
  popupPolicy: text("popup_policy", { enum: ["block", "ask", "private-tab"] }).notNull().default("ask"),
  closedTabsEnabled: integer("closed_tabs_enabled", { mode: "boolean" }).notNull().default(true),
  clearOnLogout: integer("clear_on_logout", { mode: "boolean" }).notNull().default(true),
  clearOnTabClose: integer("clear_on_tab_close", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at").notNull(),
  approvedAt: integer("approved_at"),
  approvedBy: text("approved_by"),
  passwordChangedAt: integer("password_changed_at").notNull()
}, table => [
  uniqueIndex("idx_users_username").on(table.username),
  index("idx_users_status").on(table.status)
])

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  csrfHash: text("csrf_hash").notNull(),
  createdAt: integer("created_at").notNull(),
  lastSeenAt: integer("last_seen_at").notNull(),
  idleExpiresAt: integer("idle_expires_at").notNull(),
  absoluteExpiresAt: integer("absolute_expires_at").notNull(),
  userAgentHash: text("user_agent_hash").notNull()
}, table => [
  index("idx_sessions_user_id").on(table.userId),
  index("idx_sessions_expiry").on(table.idleExpiresAt, table.absoluteExpiresAt)
])

export const loginChallenges = sqliteTable("login_challenges", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  attempts: integer("attempts").notNull().default(0)
}, table => [index("idx_login_challenges_expiry").on(table.expiresAt)])

export const invites = sqliteTable("invites", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull(),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"),
  pendingUserId: text("pending_user_id").references(() => users.id, { onDelete: "set null" })
}, table => [
  uniqueIndex("idx_invites_token_hash").on(table.tokenHash),
  index("idx_invites_created_by").on(table.createdBy)
])

export const recoveryCodes = sqliteTable("recovery_codes", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  codeHash: text("code_hash").notNull(),
  usedAt: integer("used_at")
}, table => [
  uniqueIndex("idx_recovery_codes_hash").on(table.codeHash),
  index("idx_recovery_codes_user_id").on(table.userId)
])

export const passwordResets = sqliteTable("password_resets", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at")
}, table => [uniqueIndex("idx_password_resets_token_hash").on(table.tokenHash)])

export const sitePermissions = sqliteTable("site_permissions", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  originHash: text("origin_hash").notNull(),
  originCipher: text("origin_cipher").notNull(),
  kind: text("kind").notNull(),
  decision: text("decision").notNull(),
  lastUsedAt: integer("last_used_at").notNull(),
  expiresAt: integer("expires_at")
}, table => [
  primaryKey({ columns: [table.userId, table.originHash, table.kind] }),
  index("idx_site_permissions_last_used").on(table.userId, table.lastUsedAt)
])

export const persistentStorage = sqliteTable("persistent_storage", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  originHash: text("origin_hash").notNull(),
  originCipher: text("origin_cipher").notNull(),
  encryptedPayload: text("encrypted_payload").notNull(),
  updatedAt: integer("updated_at").notNull(),
  schemaVersion: integer("schema_version").notNull().default(1)
}, table => [
  primaryKey({ columns: [table.userId, table.originHash] }),
  index("idx_persistent_storage_updated").on(table.userId, table.updatedAt)
])

export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
  event: text("event").notNull(),
  createdAt: integer("created_at").notNull()
}, table => [index("idx_audit_events_created_at").on(table.createdAt)])

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull()
})
