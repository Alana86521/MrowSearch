import { z } from "zod"

export const privacyModeSchema = z.enum(["ephemeral", "session", "persistent"])
export const historyModeSchema = z.enum(["never", "session"])
export const permissionKindSchema = z.enum(["camera", "microphone", "location", "notifications", "clipboard-read", "clipboard-write", "popups"])
export const permissionDecisionSchema = z.enum(["block", "allow-once", "allow-site"])
export const popupPolicySchema = z.enum(["block", "ask", "private-tab"])
export const trackingLevelSchema = z.enum(["off", "standard", "strict"])
export const searchEngineSchema = z.enum(["duckduckgo", "bing", "mojeek", "qwant", "yahoo", "mwmbl", "wiby", "wikipedia"])
export const userRoleSchema = z.enum(["owner", "user"])
export const userStatusSchema = z.enum(["pending", "active", "disabled"])

export type PrivacyMode = z.infer<typeof privacyModeSchema>
export type HistoryMode = z.infer<typeof historyModeSchema>
export type PermissionKind = z.infer<typeof permissionKindSchema>
export type PermissionDecision = z.infer<typeof permissionDecisionSchema>
export type PopupPolicy = z.infer<typeof popupPolicySchema>
export type TrackingLevel = z.infer<typeof trackingLevelSchema>
export type SearchEngine = z.infer<typeof searchEngineSchema>
export type UserRole = z.infer<typeof userRoleSchema>
export type UserStatus = z.infer<typeof userStatusSchema>

export const defaultSearchEngines: SearchEngine[] = ["duckduckgo", "bing", "mojeek", "qwant", "yahoo", "mwmbl", "wiby", "wikipedia"]
export const searchEnginesSchema = z.array(searchEngineSchema).min(1).max(defaultSearchEngines.length).refine(value => new Set(value).size === value.length)

export function parseSearchEngines(value: unknown): SearchEngine[] {
  try {
    const parsed = searchEnginesSchema.safeParse(typeof value === "string" ? JSON.parse(value) : value)
    return parsed.success ? parsed.data : [...defaultSearchEngines]
  } catch {
    return [...defaultSearchEngines]
  }
}

export interface ApiError {
  code: string
  message: string
  action?: string
  fieldErrors?: Record<string, string>
}

export interface SessionUser {
  id: string
  username: string
  role: UserRole
  status: UserStatus
  totpEnabled: boolean
  safeSearch: 0 | 1 | 2
  searchEngines: SearchEngine[]
  privacyMode: PrivacyMode
  historyMode: HistoryMode
  trackingLevel: TrackingLevel
  popupPolicy: PopupPolicy
  closedTabsEnabled: boolean
  clearOnLogout: boolean
  clearOnTabClose: boolean
}

export interface SessionResponse {
  setupRequired: boolean
  authenticated: boolean
  user?: SessionUser
  csrfToken?: string
}

export interface SearchResult {
  id: string
  title: string
  url: string
  displayUrl: string
  snippet: string
  source: string
  publishedAt?: string
}

export interface SearchResponse {
  query: string
  page: number
  results: SearchResult[]
  suggestions: string[]
  answers: string[]
}

export type ViewerSecurityState = "secure" | "insecure" | "unknown"
export type ViewerCompatibility = "ready" | "unsupported" | "blocked" | "failed"

export interface ViewerTab {
  id: string
  title: string
  currentUrl: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  active: boolean
  suspended: boolean
  securityState: ViewerSecurityState
  compatibility: ViewerCompatibility
}

export interface ViewerSnapshot {
  sessionId: string
  workerId: string
  tabs: ViewerTab[]
  activeTabId: string | null
  streamPath: string
}

export type ViewerCommand =
  | { type: "navigate"; tabId: string; value: string }
  | { type: "back"; tabId: string }
  | { type: "forward"; tabId: string }
  | { type: "reload"; tabId: string }
  | { type: "stop"; tabId: string }
  | { type: "new-tab"; url?: string }
  | { type: "reopen-closed" }
  | { type: "duplicate"; tabId: string }
  | { type: "activate"; tabId: string }
  | { type: "close"; tabId: string }
  | { type: "clear-history"; tabId: string }
  | { type: "download-decision"; fileId: string; decision: "approve" | "reject" }
  | { type: "set-permission"; tabId: string; permission: PermissionKind; decision: PermissionDecision }
  | { type: "link-action"; requestId: string; action: "open" | "private-tab" }
  | { type: "clipboard-decision"; requestId: string; decision: "allow" | "block"; text?: string }
  | { type: "popup-decision"; requestId: string; decision: PermissionDecision }
  | { type: "permission-decision"; requestId: string; decision: PermissionDecision }

export type ViewerEvent =
  | { type: "snapshot"; snapshot: ViewerSnapshot }
  | { type: "error"; error: ApiError }
  | { type: "popup"; requestId: string; sourceUrl: string; targetUrl: string }
  | { type: "permission"; requestId: string; origin: string; permission: PermissionKind }
  | { type: "download"; fileId: string; filename: string; sourceDomain: string; mimeType: string; size: number }
  | { type: "upload"; tabId: string; requestId: string; accept: string; multiple: boolean }
  | { type: "link-menu"; requestId: string; sourceUrl: string; targetUrl: string }
  | { type: "clipboard"; requestId: string; origin: string; operation: "clipboard-read" | "clipboard-write"; text?: string }
  | { type: "notification"; origin: string; title: string; body: string }

export const clearDataRequestSchema = z.object({
  range: z.enum(["hour", "today", "all"]),
  dataTypes: z.array(z.enum(["history", "cookies", "storage", "cache", "files", "permissions", "closed-tabs", "search-history", "form-state"])).min(1)
})

export type ClearDataRequest = z.infer<typeof clearDataRequestSchema>

export const viewerPreferencesSchema = z.object({
  safeSearch: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  searchEngines: searchEnginesSchema,
  privacyMode: privacyModeSchema,
  historyMode: historyModeSchema,
  trackingLevel: trackingLevelSchema,
  popupPolicy: popupPolicySchema,
  closedTabsEnabled: z.boolean(),
  clearOnLogout: z.boolean(),
  clearOnTabClose: z.boolean()
})

export type ViewerPreferences = z.infer<typeof viewerPreferencesSchema>
