import { existsSync } from "node:fs"
import { request as httpRequest } from "node:http"
import { join } from "node:path"
import type { ClearDataRequest, ViewerCommand, ViewerEvent, ViewerSnapshot } from "../../shared/contracts.js"

export interface WorkerStartRequest {
  sessionId: string
  userId: string
  privacyMode: "ephemeral" | "session" | "persistent"
  trackingLevel: "off" | "standard" | "strict"
  popupPolicy: "block" | "ask" | "private-tab"
  closedTabsEnabled: boolean
  storageState?: string
  permissions?: Array<{ origin: string; permission: "location" | "notifications" | "clipboard-read" | "clipboard-write"; decision: "block" | "allow-site" }>
}

export interface WorkerHealth {
  ready: boolean
  browserConnected: boolean
  sessionId: string | null
}

export class WorkerClient {
  readonly controlSocket: string
  readonly kasmSocket: string

  constructor(readonly id: string, readonly directory: string) {
    this.controlSocket = join(directory, "control.sock")
    this.kasmSocket = join(directory, "kasm.sock")
  }

  available() {
    return existsSync(this.controlSocket) && existsSync(this.kasmSocket)
  }

  health() {
    return this.requestJson<WorkerHealth>("GET", "/health")
  }

  start(request: WorkerStartRequest) {
    return this.requestJson<ViewerSnapshot>("POST", "/session/start", request)
  }

  state() {
    return this.requestJson<ViewerSnapshot>("GET", "/session/state")
  }

  events() {
    return this.requestJson<{ events: ViewerEvent[] }>("GET", "/session/events")
  }

  command(command: ViewerCommand) {
    return this.requestJson<ViewerSnapshot>("POST", "/session/command", command)
  }

  clear(full: boolean) {
    return this.requestJson<{ cleared: boolean; storageState?: string }>("POST", "/session/clear", { full })
  }

  clearData(request: ClearDataRequest) {
    return this.requestJson<ViewerSnapshot>("POST", "/session/clear-data", request)
  }

  upload(tabId: string, filename: string, mimeType: string, data: Buffer) {
    return this.requestJson<{ uploaded: boolean }>("POST", `/files/upload?tabId=${encodeURIComponent(tabId)}&filename=${encodeURIComponent(filename)}&mimeType=${encodeURIComponent(mimeType)}`, data, { "content-type": "application/octet-stream" })
  }

  download(fileId: string) {
    return this.requestStream("GET", `/files/download/${encodeURIComponent(fileId)}`)
  }

  audio() {
    return this.requestStream("GET", "/audio")
  }

  private requestJson<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
    return new Promise<T>((resolve, reject) => {
      const request = httpRequest({ socketPath: this.controlSocket, path, method, headers: { ...(payload && !Buffer.isBuffer(body) ? { "content-type": "application/json" } : {}), ...headers, ...(payload ? { "content-length": String(payload.length) } : {}) } }, response => {
        const chunks: Buffer[] = []
        response.on("data", chunk => chunks.push(Buffer.from(chunk)))
        response.on("end", () => {
          const data = Buffer.concat(chunks).toString("utf8")
          if (!response.statusCode || response.statusCode >= 400) {
            reject(new Error(data || `Worker request failed with ${response.statusCode}.`))
            return
          }
          try {
            resolve(JSON.parse(data) as T)
          } catch {
            reject(new Error("The browser worker returned invalid JSON."))
          }
        })
      })
      request.setTimeout(30000, () => request.destroy(new Error("The browser worker request timed out.")))
      request.on("error", reject)
      if (payload) {
        request.write(payload)
      }
      request.end()
    })
  }

  private requestStream(method: string, path: string) {
    return new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      const request = httpRequest({ socketPath: this.controlSocket, path, method }, response => {
        if (!response.statusCode || response.statusCode >= 400) {
          response.resume()
          reject(new Error("The browser worker could not supply the file."))
          return
        }
        resolve(response)
      })
      request.on("error", reject)
      request.end()
    })
  }
}
