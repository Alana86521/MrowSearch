import BetterSqlite3 from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import type { AppConfig } from "../config.js"
import * as schema from "./schema.js"

const migrationSql = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  totp_secret TEXT,
  totp_enabled INTEGER DEFAULT 0 NOT NULL,
  safe_search INTEGER DEFAULT 1 NOT NULL,
  search_engines TEXT DEFAULT '["duckduckgo","bing","mojeek","qwant","yahoo","mwmbl","wiby","wikipedia"]' NOT NULL,
  privacy_mode TEXT DEFAULT 'session' NOT NULL,
  history_mode TEXT DEFAULT 'session' NOT NULL,
  tracking_level TEXT DEFAULT 'standard' NOT NULL,
  popup_policy TEXT DEFAULT 'ask' NOT NULL,
  closed_tabs_enabled INTEGER DEFAULT 1 NOT NULL,
  clear_on_logout INTEGER DEFAULT 1 NOT NULL,
  clear_on_tab_close INTEGER DEFAULT 1 NOT NULL,
  created_at INTEGER NOT NULL,
  approved_at INTEGER,
  approved_by TEXT,
  password_changed_at INTEGER NOT NULL,
  FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  csrf_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  idle_expires_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  user_agent_hash TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(idle_expires_at, absolute_expires_at);
CREATE TABLE IF NOT EXISTS login_challenges (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER DEFAULT 0 NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_login_challenges_expiry ON login_challenges(expires_at);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY NOT NULL,
  token_hash TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  pending_user_id TEXT,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (pending_user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invites_token_hash ON invites(token_hash);
CREATE INDEX IF NOT EXISTS idx_invites_created_by ON invites(created_by);
CREATE TABLE IF NOT EXISTS recovery_codes (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  used_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_recovery_codes_hash ON recovery_codes(code_hash);
CREATE INDEX IF NOT EXISTS idx_recovery_codes_user_id ON recovery_codes(user_id);
CREATE TABLE IF NOT EXISTS password_resets (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_password_resets_token_hash ON password_resets(token_hash);
CREATE TABLE IF NOT EXISTS site_permissions (
  user_id TEXT NOT NULL,
  origin_hash TEXT NOT NULL,
  origin_cipher TEXT NOT NULL,
  kind TEXT NOT NULL,
  decision TEXT NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (user_id, origin_hash, kind),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_site_permissions_last_used ON site_permissions(user_id, last_used_at);
CREATE TABLE IF NOT EXISTS persistent_storage (
  user_id TEXT NOT NULL,
  origin_hash TEXT NOT NULL,
  origin_cipher TEXT NOT NULL,
  encrypted_payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  schema_version INTEGER DEFAULT 1 NOT NULL,
  PRIMARY KEY (user_id, origin_hash),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_persistent_storage_updated ON persistent_storage(user_id, updated_at);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT,
  actor_id TEXT,
  event TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events(created_at);
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`

export function createDatabase(config: AppConfig) {
  const sqlite = new BetterSqlite3(config.databasePath)
  sqlite.pragma("journal_mode = WAL")
  sqlite.pragma("foreign_keys = ON")
  sqlite.pragma("busy_timeout = 5000")
  sqlite.exec(migrationSql)
  const userColumns = sqlite.pragma("table_info(users)") as Array<{ name: string }>
  if (!userColumns.some(column => column.name === "search_engines")) {
    sqlite.exec(`ALTER TABLE users ADD COLUMN search_engines TEXT DEFAULT '["duckduckgo","bing","mojeek","qwant","yahoo","mwmbl","wiby","wikipedia"]' NOT NULL`)
  }
  sqlite.pragma("optimize")
  return {
    sqlite,
    db: drizzle(sqlite, { schema })
  }
}

export type DatabaseBundle = ReturnType<typeof createDatabase>
export type AppDatabase = DatabaseBundle["db"]
