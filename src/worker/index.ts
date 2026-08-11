import { randomUUID } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { chmodSync, createReadStream, existsSync, mkdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { chromium, type Browser, type BrowserContext, type Download, type FileChooser, type Page } from "playwright-core"
import type { ClearDataRequest, PrivacyMode, TrackingLevel, PopupPolicy, ViewerCommand, ViewerEvent, ViewerSnapshot, ViewerTab } from "../shared/contracts.js"
import { isTrackerHost } from "../shared/tracking.js"
import { classifyAddressInput, cleanTrackingParameters } from "../shared/url.js"

interface WorkerSession {
  sessionId: string
  userId: string
  privacyMode: PrivacyMode
  trackingLevel: TrackingLevel
  popupPolicy: PopupPolicy
  sharedContext: BrowserContext | null
  tabs: Map<string, TabRecord>
  activeTabId: string | null
  permissions: Array<{ origin: string; permission: "location" | "notifications" | "clipboard-read" | "clipboard-write"; decision: "block" | "allow-site" }>
  closedTabsEnabled: boolean
  closedTabs: Array<{ url: string; closedAt: number }>
}

interface TabRecord {
  id: string
  context: BrowserContext
  page: Page
  loading: boolean
  suspended: boolean
  lastActiveAt: number
  attemptedUrl: string
  compatibility: "ready" | "unsupported" | "blocked" | "failed"
}

interface DownloadRecord {
  id: string
  download: Download
  path: string
  filename: string
  mimeType: string
  sourceDomain: string
  createdAt: number
  approved: boolean
}

const socketDirectory = process.env.MROW_WORKER_SOCKET_DIRECTORY ?? "/run/mrow"
const controlSocket = join(socketDirectory, "control.sock")
const remoteDebuggingUrl = process.env.MROW_CHROMIUM_DEBUG_URL ?? "http://127.0.0.1:9222"
const maxTabs = 4
const maxUploadBytes = Number(process.env.MROW_MAX_UPLOAD_BYTES ?? 104857600)
const maxDownloadBytes = Number(process.env.MROW_MAX_DOWNLOAD_BYTES ?? 1073741824)
const maxTempBytes = Number(process.env.MROW_MAX_TEMP_BYTES ?? 2147483648)

mkdirSync(socketDirectory, { recursive: true })
if (existsSync(controlSocket)) {
  rmSync(controlSocket)
}

let browser: Browser | null = null
let session: WorkerSession | null = null
const pendingChoosers = new Map<string, FileChooser>()
const downloads = new Map<string, DownloadRecord>()
const events: ViewerEvent[] = []
const pendingPopups = new Map<string, { sourceTab: TabRecord; popup: Page }>()
const pendingLinks = new Map<string, { sourceTab: TabRecord; targetUrl: string }>()
const pendingClipboards = new Map<string, { operation: "clipboard-read" | "clipboard-write"; resolve: (value: string) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }>()

async function connectBrowser() {
  while (!browser) {
    try {
      browser = await chromium.connectOverCDP(remoteDebuggingUrl)
      browser.on("disconnected", () => {
        browser = null
        session = null
      })
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
  }
}

void connectBrowser()

async function createContext(trackingLevel: TrackingLevel, storageState?: string, permissions: WorkerSession["permissions"] = []) {
  if (!browser) {
    throw new Error("Chromium is not connected.")
  }
  const context = await browser.newContext({
    acceptDownloads: true,
    serviceWorkers: "allow",
    viewport: null,
    storageState: storageState ? JSON.parse(storageState) : undefined,
    extraHTTPHeaders: { DNT: "1", "Sec-GPC": "1" }
  })
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "globalPrivacyControl", { configurable: false, enumerable: true, value: true })
    const clipboard = {
      readText: () => (window as unknown as { __mrowClipboard: (operation: string, text: string) => Promise<string> }).__mrowClipboard("clipboard-read", ""),
      writeText: (text: string) => (window as unknown as { __mrowClipboard: (operation: string, text: string) => Promise<string> }).__mrowClipboard("clipboard-write", String(text)).then(() => undefined)
    }
    try {
      Object.defineProperty(navigator, "clipboard", { configurable: false, value: clipboard })
    } catch {}
    const nativeNotification = window.Notification
    if (nativeNotification) {
      class LocalNotification extends EventTarget {
        static get permission() {
          return nativeNotification.permission
        }

        static requestPermission(callback?: NotificationPermissionCallback) {
          const decision = nativeNotification.permission === "granted" ? "granted" : "denied"
          callback?.(decision)
          return Promise.resolve(decision)
        }

        onclick: ((this: Notification, event: Event) => unknown) | null = null
        onclose: ((this: Notification, event: Event) => unknown) | null = null
        onerror: ((this: Notification, event: Event) => unknown) | null = null
        onshow: ((this: Notification, event: Event) => unknown) | null = null

        constructor(title: string, options?: NotificationOptions) {
          super()
          if (nativeNotification.permission === "granted") {
            void (window as unknown as { __mrowNotification: (title: string, body: string) => Promise<void> }).__mrowNotification(String(title), String(options?.body ?? ""))
          }
        }

        close() {}
      }
      Object.defineProperty(window, "Notification", { configurable: false, value: LocalNotification })
    }
    document.addEventListener("contextmenu", event => {
      const target = event.target instanceof Element ? event.target.closest("a[href]") : null
      if (target instanceof HTMLAnchorElement) {
        event.preventDefault()
        void (window as unknown as { __mrowLinkMenu: (url: string) => Promise<void> }).__mrowLinkMenu(target.href)
      }
    }, true)
  })
  await context.exposeBinding("__mrowLinkMenu", ({ page }, targetUrl: string) => {
    const sourceTab = session ? [...session.tabs.values()].find(value => value.page === page) : undefined
    if (!sourceTab) {
      return
    }
    const requestId = randomUUID()
    pendingLinks.set(requestId, { sourceTab, targetUrl })
    events.push({ type: "link-menu", requestId, sourceUrl: page.url(), targetUrl })
  })
  await context.exposeBinding("__mrowNotification", ({ page }, title: string, body: string) => {
    let origin = "Unknown site"
    try {
      origin = new URL(page.url()).origin
    } catch {}
    events.push({ type: "notification", origin, title: title.slice(0, 200), body: body.slice(0, 1000) })
  })
  await context.exposeBinding("__mrowClipboard", ({ page }, operation: "clipboard-read" | "clipboard-write", text: string) => {
    if (!session || !["clipboard-read", "clipboard-write"].includes(operation) || Buffer.byteLength(text, "utf8") > 1048576) {
      throw new Error("The clipboard request is not allowed.")
    }
    const requestId = randomUUID()
    let origin = "Unknown site"
    try {
      origin = new URL(page.url()).origin
    } catch {}
    events.push({ type: "clipboard", requestId, origin, operation, text: operation === "clipboard-write" ? text : undefined })
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingClipboards.delete(requestId)
        reject(new Error("The clipboard request expired."))
      }, 60000)
      pendingClipboards.set(requestId, { operation, resolve, reject, timeout })
    })
  })
  await context.route("**/*", async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (trackingLevel !== "off" && isTrackerHost(url.hostname)) {
      await route.abort("blockedbyclient")
      return
    }
    const headers = { ...request.headers() }
    const source = request.frame().url()
    if (headers.referer && source) {
      try {
        const sourceUrl = new URL(source)
        if (sourceUrl.origin !== url.origin) {
          if (trackingLevel === "strict") {
            delete headers.referer
          } else {
            headers.referer = `${sourceUrl.origin}/`
          }
        }
      } catch {}
    }
    await route.continue({ headers })
  })
  await applyPermissions(context, permissions)
  return context
}

async function applyPermissions(context: BrowserContext, permissions: WorkerSession["permissions"]) {
  await context.clearPermissions()
  const allowed = permissions.filter(value => value.decision === "allow-site")
  const origins = [...new Set(allowed.map(value => value.origin))]
  for (const origin of origins) {
    const values = allowed.filter(value => value.origin === origin).map(value => value.permission === "location" ? "geolocation" : value.permission)
    if (values.length > 0) {
      await context.grantPermissions(values, { origin })
    }
  }
}

async function startSession(body: { sessionId: string; userId: string; privacyMode: PrivacyMode; trackingLevel: TrackingLevel; popupPolicy: PopupPolicy; closedTabsEnabled: boolean; storageState?: string; permissions?: WorkerSession["permissions"] }) {
  await clearSession(false)
  if (!browser) {
    await connectBrowser()
  }
  const permissions = body.permissions ?? []
  const sharedContext = body.privacyMode === "ephemeral" ? null : await createContext(body.trackingLevel, body.storageState, permissions)
  session = { sessionId: body.sessionId, userId: body.userId, privacyMode: body.privacyMode, trackingLevel: body.trackingLevel, popupPolicy: body.popupPolicy, sharedContext, tabs: new Map(), activeTabId: null, permissions, closedTabsEnabled: body.closedTabsEnabled, closedTabs: [] }
  await createTab("about:blank")
  return snapshot()
}

async function createTab(url = "about:blank", activate = true) {
  if (!session) {
    throw new Error("A viewer session is not active.")
  }
  if (session.tabs.size >= maxTabs) {
    throw new Error("The private tab limit is four.")
  }
  const context = session.privacyMode === "ephemeral" ? await createContext(session.trackingLevel, undefined, session.permissions) : session.sharedContext
  if (!context) {
    throw new Error("The browser context is not available.")
  }
  const page = await context.newPage()
  const tab: TabRecord = { id: randomUUID(), context, page, loading: false, suspended: false, lastActiveAt: Date.now(), attemptedUrl: url, compatibility: "ready" }
  session.tabs.set(tab.id, tab)
  bindPage(tab)
  if (url !== "about:blank") {
    await navigate(tab, url)
  }
  if (activate) {
    await activateTab(tab.id)
  }
  return tab
}

function bindPage(tab: TabRecord) {
  tab.page.on("load", () => {
    tab.loading = false
  })
  tab.page.on("domcontentloaded", () => {
    tab.loading = false
  })
  tab.page.on("request", request => {
    if (request.isNavigationRequest() && request.frame() === tab.page.mainFrame()) {
      tab.loading = true
    }
  })
  tab.page.on("requestfailed", request => {
    if (request.isNavigationRequest()) {
      tab.loading = false
      tab.compatibility = request.failure()?.errorText.includes("BLOCKED") ? "blocked" : "failed"
    }
  })
  tab.page.on("response", response => {
    if (response.request().isNavigationRequest() && response.request().frame() === tab.page.mainFrame() && response.status() >= 400) {
      tab.compatibility = response.status() === 403 ? "blocked" : "failed"
    }
  })
  tab.page.on("filechooser", async chooser => {
    pendingChoosers.set(tab.id, chooser)
    const accept = await chooser.element().getAttribute("accept") ?? ""
    events.push({ type: "upload", tabId: tab.id, requestId: randomUUID(), accept, multiple: chooser.isMultiple() })
  })
  tab.page.on("download", download => void recordDownload(tab, download))
  tab.page.on("popup", async popup => {
    if (!session || session.popupPolicy === "block" || session.tabs.size >= maxTabs) {
      await popup.close()
      return
    }
    if (session.popupPolicy === "ask") {
      const requestId = randomUUID()
      pendingPopups.set(requestId, { sourceTab: tab, popup })
      events.push({ type: "popup", requestId, sourceUrl: tab.page.url(), targetUrl: popup.url() })
      return
    }
    const popupTab: TabRecord = { id: randomUUID(), context: tab.context, page: popup, loading: true, suspended: false, lastActiveAt: Date.now(), attemptedUrl: popup.url(), compatibility: "ready" }
    session.tabs.set(popupTab.id, popupTab)
    bindPage(popupTab)
    if (session.popupPolicy === "private-tab") {
      await activateTab(popupTab.id)
    }
  })
  tab.page.on("close", () => {
    session?.tabs.delete(tab.id)
    if (session?.activeTabId === tab.id) {
      session.activeTabId = session.tabs.keys().next().value ?? null
    }
  })
}

async function recordDownload(tab: TabRecord, download: Download) {
  const path = await download.path()
  if (!path || !existsSync(path)) {
    return
  }
  const size = statSync(path).size
  const currentTemporaryBytes = [...downloads.values()].reduce((total, value) => total + (existsSync(value.path) ? statSync(value.path).size : 0), 0)
  if (size > maxDownloadBytes || currentTemporaryBytes + size > maxTempBytes) {
    await download.cancel()
    rmSync(path, { force: true })
    return
  }
  const sourceDomain = (() => {
    try {
      return new URL(tab.page.url()).hostname
    } catch {
      return "Unknown source"
    }
  })()
  const id = randomUUID()
  const filename = download.suggestedFilename()
  const mimeType = "application/octet-stream"
  downloads.set(id, { id, download, path, filename, mimeType, sourceDomain, createdAt: Date.now(), approved: false })
  events.push({ type: "download", fileId: id, filename, sourceDomain, mimeType, size })
}

async function navigate(tab: TabRecord, value: string) {
  const address = classifyAddressInput(value)
  if (address.kind !== "url") {
    throw new Error("The address is a search query, not a URL.")
  }
  const url = session?.trackingLevel === "off" ? new URL(address.url) : cleanTrackingParameters(new URL(address.url))
  tab.attemptedUrl = url.toString()
  tab.compatibility = "ready"
  tab.loading = true
  await tab.page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {
    tab.loading = false
    tab.compatibility = "failed"
    return null
  })
  tab.loading = false
}

async function activateTab(tabId: string) {
  if (!session) {
    throw new Error("A viewer session is not active.")
  }
  const tab = session.tabs.get(tabId)
  if (!tab) {
    throw new Error("The private tab does not exist.")
  }
  for (const other of session.tabs.values()) {
    if (other.id !== tab.id && Date.now() - other.lastActiveAt > 120000) {
      const client = await other.context.newCDPSession(other.page)
      await client.send("Page.setWebLifecycleState", { state: "frozen" }).catch(() => undefined)
      await client.detach()
      other.suspended = true
    }
  }
  if (tab.suspended) {
    const client = await tab.context.newCDPSession(tab.page)
    await client.send("Page.setWebLifecycleState", { state: "active" }).catch(() => undefined)
    await client.detach()
    tab.suspended = false
  }
  tab.lastActiveAt = Date.now()
  session.activeTabId = tab.id
  await tab.page.bringToFront()
}

async function command(value: ViewerCommand) {
  if (!session) {
    throw new Error("A viewer session is not active.")
  }
  if (value.type === "new-tab") {
    await createTab(value.url ?? "about:blank")
    return snapshot()
  }
  if (value.type === "reopen-closed") {
    const closed = session.closedTabs.shift()
    if (closed) {
      await createTab(closed.url)
    }
    return snapshot()
  }
  if (value.type === "popup-decision") {
    const pending = pendingPopups.get(value.requestId)
    if (!pending) {
      throw new Error("The popup request is no longer available.")
    }
    pendingPopups.delete(value.requestId)
    if (value.decision === "block" || session.tabs.size >= maxTabs) {
      await pending.popup.close()
      return snapshot()
    }
    const popupTab: TabRecord = { id: randomUUID(), context: pending.sourceTab.context, page: pending.popup, loading: true, suspended: false, lastActiveAt: Date.now(), attemptedUrl: pending.popup.url(), compatibility: "ready" }
    session.tabs.set(popupTab.id, popupTab)
    bindPage(popupTab)
    await activateTab(popupTab.id)
    return snapshot()
  }
  if (value.type === "permission-decision") {
    return snapshot()
  }
  if (value.type === "link-action") {
    const pending = pendingLinks.get(value.requestId)
    if (!pending) {
      throw new Error("The link request is no longer available.")
    }
    pendingLinks.delete(value.requestId)
    if (value.action === "private-tab") {
      await createTab(pending.targetUrl)
    } else {
      await navigate(pending.sourceTab, pending.targetUrl)
      await activateTab(pending.sourceTab.id)
    }
    return snapshot()
  }
  if (value.type === "clipboard-decision") {
    const pending = pendingClipboards.get(value.requestId)
    if (!pending) {
      throw new Error("The clipboard request is no longer available.")
    }
    pendingClipboards.delete(value.requestId)
    clearTimeout(pending.timeout)
    if (value.decision === "block" || Buffer.byteLength(value.text ?? "", "utf8") > 1048576) {
      pending.reject(new Error("The clipboard request was blocked."))
    } else {
      pending.resolve(value.text ?? "")
    }
    return snapshot()
  }
  if (value.type === "download-decision") {
    const download = downloads.get(value.fileId)
    if (!download) {
      throw new Error("The temporary download is no longer available.")
    }
    if (value.decision === "reject") {
      if (existsSync(download.path)) {
        rmSync(download.path, { force: true })
      }
      downloads.delete(value.fileId)
    } else {
      download.approved = true
    }
    return snapshot()
  }
  const tab = session.tabs.get(value.tabId)
  if (!tab) {
    throw new Error("The private tab does not exist.")
  }
  if (value.type === "set-permission") {
    if (["camera", "microphone"].includes(value.permission)) {
      throw new Error("Camera and microphone access are always blocked.")
    }
    const origin = new URL(tab.page.url()).origin
    session.permissions = session.permissions.filter(item => !(item.origin === origin && item.permission === value.permission))
    if (value.decision !== "block") {
      session.permissions.push({ origin, permission: value.permission as "location" | "notifications" | "clipboard-read" | "clipboard-write", decision: "allow-site" })
    }
    for (const context of new Set([...session.tabs.values()].map(item => item.context))) {
      await applyPermissions(context, session.permissions)
    }
    return snapshot()
  }
  if (value.type === "navigate") {
    await navigate(tab, value.value)
  }
  if (value.type === "back") {
    await tab.page.goBack({ waitUntil: "domcontentloaded", timeout: 30000 })
  }
  if (value.type === "forward") {
    await tab.page.goForward({ waitUntil: "domcontentloaded", timeout: 30000 })
  }
  if (value.type === "reload") {
    await tab.page.reload({ waitUntil: "domcontentloaded", timeout: 30000 })
  }
  if (value.type === "stop") {
    const client = await tab.context.newCDPSession(tab.page)
    await client.send("Page.stopLoading")
    await client.detach()
    tab.loading = false
  }
  if (value.type === "activate") {
    await activateTab(tab.id)
  }
  if (value.type === "duplicate") {
    await createTab(tab.page.url())
  }
  if (value.type === "clear-history") {
    const client = await tab.context.newCDPSession(tab.page)
    await client.send("Page.resetNavigationHistory")
    await client.detach()
  }
  if (value.type === "close") {
    const context = tab.context
    const closedUrl = tab.page.url()
    if (session.closedTabsEnabled && closedUrl !== "about:blank") {
      session.closedTabs.unshift({ url: closedUrl, closedAt: Date.now() })
      session.closedTabs.splice(10)
    }
    await tab.page.close()
    session.tabs.delete(tab.id)
    if (session.privacyMode === "ephemeral") {
      await context.close()
    }
    if (session.tabs.size === 0) {
      await createTab("about:blank")
    } else if (session.activeTabId === tab.id || !session.activeTabId) {
      const next = session.tabs.values().next().value as TabRecord
      await activateTab(next.id)
    }
  }
  return snapshot()
}

async function snapshot(): Promise<ViewerSnapshot> {
  if (!session) {
    throw new Error("A viewer session is not active.")
  }
  const tabs: ViewerTab[] = []
  for (const tab of session.tabs.values()) {
    const client = await tab.context.newCDPSession(tab.page)
    const history = await client.send("Page.getNavigationHistory").catch(() => ({ currentIndex: 0, entries: [] }))
    await client.detach()
    const pageUrl = tab.page.url()
    const url = pageUrl.startsWith("http://") || pageUrl.startsWith("https://") ? pageUrl : tab.attemptedUrl
    tabs.push({
      id: tab.id,
      title: await tab.page.title().catch(() => "New tab") || "New tab",
      currentUrl: url === "about:blank" ? "" : url,
      canGoBack: history.currentIndex > 0,
      canGoForward: history.currentIndex < history.entries.length - 1,
      loading: tab.loading,
      active: tab.id === session.activeTabId,
      suspended: tab.suspended,
      securityState: url.startsWith("https://") ? "secure" : url.startsWith("http://") ? "insecure" : "unknown",
      compatibility: tab.compatibility
    })
  }
  return { sessionId: session.sessionId, workerId: process.env.MROW_WORKER_ID ?? "worker", tabs, activeTabId: session.activeTabId, streamPath: "/api/viewer/kasm/?autoconnect=1&resize=remote&path=api%2Fviewer%2Fstream" }
}

async function clearSession(full: boolean) {
  if (!session) {
    return { cleared: true }
  }
  let storageState: string | undefined
  if (!full && session.privacyMode === "persistent" && session.sharedContext) {
    const state = await session.sharedContext.storageState({ indexedDB: true })
    state.cookies = state.cookies.filter(cookie => cookie.expires > 0)
    storageState = JSON.stringify(state)
  }
  const contexts = new Set([...session.tabs.values()].map(tab => tab.context))
  if (session.sharedContext) {
    contexts.add(session.sharedContext)
  }
  for (const context of contexts) {
    await context.close().catch(() => undefined)
  }
  session = null
  pendingChoosers.clear()
  for (const pending of pendingPopups.values()) {
    await pending.popup.close().catch(() => undefined)
  }
  pendingPopups.clear()
  pendingLinks.clear()
  for (const pending of pendingClipboards.values()) {
    clearTimeout(pending.timeout)
    pending.reject(new Error("The viewer session ended."))
  }
  pendingClipboards.clear()
  for (const download of downloads.values()) {
    if (existsSync(download.path)) {
      rmSync(download.path, { force: true })
    }
  }
  downloads.clear()
  events.splice(0, events.length)
  return { cleared: true, storageState }
}

async function clearData(request: ClearDataRequest) {
  if (!session) {
    throw new Error("A viewer session is not active.")
  }
  const threshold = request.range === "all" ? 0 : request.range === "hour" ? Date.now() - 3600000 : new Date(new Date().setHours(0, 0, 0, 0)).getTime()
  const targetTabs = [...session.tabs.values()].filter(tab => tab.lastActiveAt >= threshold)
  const contexts = new Set(targetTabs.map(tab => tab.context))
  if (request.dataTypes.includes("cookies")) {
    await Promise.all([...contexts].map(context => context.clearCookies()))
  }
  if (request.dataTypes.some(value => ["storage", "form-state"].includes(value))) {
    for (const tab of targetTabs) {
      const url = tab.page.url()
      if (!url.startsWith("http://") && !url.startsWith("https://")) continue
      const client = await tab.context.newCDPSession(tab.page)
      await client.send("Storage.clearDataForOrigin", { origin: new URL(url).origin, storageTypes: "all" }).catch(() => undefined)
      await client.detach()
      if (request.dataTypes.includes("form-state")) {
        await tab.page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => undefined)
      }
    }
  }
  if (request.dataTypes.includes("cache")) {
    for (const tab of targetTabs) {
      const client = await tab.context.newCDPSession(tab.page)
      await client.send("Network.clearBrowserCache").catch(() => undefined)
      await client.detach()
    }
  }
  if (request.dataTypes.includes("history")) {
    for (const tab of targetTabs) {
      const client = await tab.context.newCDPSession(tab.page)
      await client.send("Page.resetNavigationHistory").catch(() => undefined)
      await client.detach()
    }
  }
  if (request.dataTypes.includes("permissions")) {
    session.permissions = []
    await Promise.all([...contexts].map(context => context.clearPermissions()))
  }
  if (request.dataTypes.includes("closed-tabs")) {
    session.closedTabs = session.closedTabs.filter(value => value.closedAt < threshold)
  }
  if (request.dataTypes.includes("files")) {
    for (const [id, download] of downloads) {
      if (download.createdAt < threshold) continue
      if (existsSync(download.path)) rmSync(download.path, { force: true })
      downloads.delete(id)
    }
    pendingChoosers.clear()
  }
  return snapshot()
}

async function readBody(request: IncomingMessage, limit = 1048576) {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    length += buffer.length
    if (length > limit) {
      throw new Error("The request body is too large.")
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  const body = Buffer.from(JSON.stringify(value))
  response.writeHead(status, { "content-type": "application/json", "content-length": String(body.length), "cache-control": "no-store" })
  response.end(body)
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://worker.local")
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ready: Boolean(browser), browserConnected: Boolean(browser), sessionId: session?.sessionId ?? null })
      return
    }
    if (request.method === "POST" && url.pathname === "/session/start") {
      const body = JSON.parse((await readBody(request)).toString("utf8"))
      sendJson(response, 200, await startSession(body))
      return
    }
    if (request.method === "GET" && url.pathname === "/session/state") {
      sendJson(response, 200, await snapshot())
      return
    }
    if (request.method === "GET" && url.pathname === "/session/events") {
      const pending = events.splice(0, events.length)
      sendJson(response, 200, { events: pending })
      return
    }
    if (request.method === "POST" && url.pathname === "/session/command") {
      const body = JSON.parse((await readBody(request)).toString("utf8")) as ViewerCommand
      sendJson(response, 200, await command(body))
      return
    }
    if (request.method === "POST" && url.pathname === "/session/clear") {
      const body = JSON.parse((await readBody(request)).toString("utf8")) as { full: boolean }
      sendJson(response, 200, await clearSession(body.full))
      return
    }
    if (request.method === "POST" && url.pathname === "/session/clear-data") {
      const body = JSON.parse((await readBody(request)).toString("utf8")) as ClearDataRequest
      sendJson(response, 200, await clearData(body))
      return
    }
    if (request.method === "GET" && url.pathname === "/audio") {
      if (!session) {
        sendJson(response, 409, { code: "VIEWER_NOT_ACTIVE" })
        return
      }
      response.writeHead(200, { "content-type": "audio/webm; codecs=opus", "cache-control": "no-store", "x-content-type-options": "nosniff" })
      const encoder = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "pulse", "-i", process.env.MROW_PULSE_SOURCE ?? "@DEFAULT_MONITOR@", "-ac", "2", "-ar", "48000", "-c:a", "libopus", "-b:a", "96k", "-f", "webm", "-cluster_time_limit", "100", "-flush_packets", "1", "pipe:1"], { stdio: ["ignore", "pipe", "ignore"] })
      encoder.stdout.pipe(response)
      response.once("close", () => encoder.kill("SIGTERM"))
      encoder.once("error", () => response.destroy())
      return
    }
    if (request.method === "POST" && url.pathname === "/files/upload") {
      const tabId = url.searchParams.get("tabId") ?? ""
      const chooser = pendingChoosers.get(tabId)
      if (!chooser) {
        throw new Error("The site is not waiting for a file.")
      }
      const data = await readBody(request, maxUploadBytes)
      const filename = url.searchParams.get("filename") ?? "upload.bin"
      const mimeType = url.searchParams.get("mimeType") ?? "application/octet-stream"
      await chooser.setFiles({ name: filename, mimeType, buffer: data })
      pendingChoosers.delete(tabId)
      sendJson(response, 200, { uploaded: true })
      return
    }
    if (request.method === "GET" && url.pathname.startsWith("/files/download/")) {
      const fileId = url.pathname.slice("/files/download/".length)
      const download = downloads.get(fileId)
      if (!download || !download.approved || !existsSync(download.path)) {
        sendJson(response, 404, { code: "DOWNLOAD_NOT_FOUND" })
        return
      }
      const size = statSync(download.path).size
      response.writeHead(200, { "content-type": download.mimeType, "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(download.filename)}`, "content-length": String(size), "cache-control": "no-store" })
      const stream = createReadStream(download.path)
      stream.pipe(response)
      stream.once("close", () => {
        if (existsSync(download.path)) {
          rmSync(download.path, { force: true })
        }
        downloads.delete(fileId)
      })
      return
    }
    sendJson(response, 404, { code: "NOT_FOUND" })
  } catch (error) {
    sendJson(response, 500, { code: "WORKER_FAILED", message: error instanceof Error ? error.message : "The browser worker failed." })
  }
})

server.listen(controlSocket, () => chmodSync(controlSocket, 0o600))

setInterval(() => {
  const threshold = Date.now() - 900000
  for (const [id, download] of downloads) {
    if (download.createdAt < threshold) {
      if (existsSync(download.path)) {
        rmSync(download.path, { force: true })
      }
      downloads.delete(id)
    }
  }
}, 60000).unref()
