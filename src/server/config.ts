import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { z } from "zod"

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  MROW_HOST: z.string().default("0.0.0.0"),
  MROW_PORT: z.coerce.number().int().min(1).max(65535).default(3080),
  MROW_PUBLIC_URL: z.string().url().default("http://127.0.0.1:3080"),
  MROW_ALLOWED_ORIGINS: z.string().default(""),
  MROW_ALLOW_INSECURE_HTTP: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  MROW_DATABASE_PATH: z.string().default("./data/mrowsearch.db"),
  MROW_SETUP_TOKEN: z.string().min(24).default("development-setup-token-change-me"),
  MROW_DATA_KEY: z.string().default("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
  MROW_SESSION_SECRET: z.string().min(32).default("development-session-secret-change-me-now"),
  MROW_SEARXNG_URL: z.string().url().default("http://127.0.0.1:8888"),
  MROW_EGRESS_SETTINGS_PATH: z.string().default("./data/egress-settings.json"),
  MROW_EGRESS_SOCKET: z.string().default("./data/egress/proxy.sock"),
  MROW_WORKER_DIRECTORIES: z.string().default("./data/workers/worker-1,./data/workers/worker-2,./data/workers/worker-3,./data/workers/worker-4"),
  MROW_WORKER_PASSWORD: z.string().min(12).default("development-viewer-password"),
  MROW_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(104857600),
  MROW_MAX_DOWNLOAD_BYTES: z.coerce.number().int().positive().default(1073741824),
  MROW_MAX_TEMP_BYTES: z.coerce.number().int().positive().default(2147483648),
  MROW_IDLE_SESSION_SECONDS: z.coerce.number().int().min(300).default(1800),
  MROW_ABSOLUTE_SESSION_SECONDS: z.coerce.number().int().min(1800).default(43200),
  MROW_VIEWER_IDLE_SECONDS: z.coerce.number().int().min(60).default(900),
  MROW_VIEWER_LEASE_SECONDS: z.coerce.number().int().min(30).default(90),
  MROW_AUDIT_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  MROW_TRUST_PROXY: z.string().default("127.0.0.1,::1")
})

export type AppConfig = ReturnType<typeof loadConfig>

export function loadConfig(source: NodeJS.ProcessEnv = process.env) {
  const values = environmentSchema.parse(source)
  const databasePath = resolve(values.MROW_DATABASE_PATH)
  mkdirSync(dirname(databasePath), { recursive: true })
  const dataKey = Buffer.from(values.MROW_DATA_KEY, "base64")
  if (dataKey.length !== 32) {
    throw new Error("MROW_DATA_KEY must contain exactly 32 base64-encoded bytes.")
  }
  const publicUrl = new URL(values.MROW_PUBLIC_URL)
  if (values.NODE_ENV === "production" && publicUrl.protocol !== "https:" && !values.MROW_ALLOW_INSECURE_HTTP) {
    throw new Error("MROW_PUBLIC_URL must use HTTPS in production unless MROW_ALLOW_INSECURE_HTTP is true.")
  }
  const allowedOrigins = new Set([
    publicUrl.origin,
    ...values.MROW_ALLOWED_ORIGINS.split(",").map(value => value.trim()).filter(Boolean).map(value => new URL(value).origin)
  ])
  return {
    environment: values.NODE_ENV,
    host: values.MROW_HOST,
    port: values.MROW_PORT,
    publicUrl,
    allowedOrigins,
    databasePath,
    setupToken: values.MROW_SETUP_TOKEN,
    dataKey,
    sessionSecret: Buffer.from(values.MROW_SESSION_SECRET, "utf8"),
    searxngUrl: new URL(values.MROW_SEARXNG_URL),
    egressSettingsPath: resolve(values.MROW_EGRESS_SETTINGS_PATH),
    egressSocket: resolve(values.MROW_EGRESS_SOCKET),
    workerDirectories: values.MROW_WORKER_DIRECTORIES.split(",").map(value => resolve(value.trim())).filter(Boolean),
    workerPassword: values.MROW_WORKER_PASSWORD,
    maxUploadBytes: values.MROW_MAX_UPLOAD_BYTES,
    maxDownloadBytes: values.MROW_MAX_DOWNLOAD_BYTES,
    maxTempBytes: values.MROW_MAX_TEMP_BYTES,
    idleSessionSeconds: values.MROW_IDLE_SESSION_SECONDS,
    absoluteSessionSeconds: values.MROW_ABSOLUTE_SESSION_SECONDS,
    viewerIdleSeconds: values.MROW_VIEWER_IDLE_SECONDS,
    viewerLeaseSeconds: values.MROW_VIEWER_LEASE_SECONDS,
    auditRetentionDays: values.MROW_AUDIT_RETENTION_DAYS,
    trustProxy: values.MROW_TRUST_PROXY.split(",").map(value => value.trim()).filter(Boolean),
    secureCookies: publicUrl.protocol === "https:",
    cookieName: publicUrl.protocol === "https:" ? "__Host-mrow_session" : "mrow_session"
  }
}
