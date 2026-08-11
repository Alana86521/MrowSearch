import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import { WebSocket, WebSocketServer } from "ws"
import type { ViewerCommand, ViewerEvent } from "../../shared/contracts.js"
import type { AppConfig } from "../config.js"
import type { AuthService, AuthContext } from "./auth.js"
import type { ViewerService } from "./viewer.js"
import type { ViewerProxy } from "./viewer-proxy.js"

export class RealtimeService {
  private readonly server = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1048576 })
  private readonly clients = new Map<string, Set<WebSocket>>()

  constructor(private readonly auth: AuthService, private readonly viewer: ViewerService, private readonly viewerProxy: ViewerProxy, private readonly config: AppConfig) {
    viewer.on("snapshot", (userId, snapshot) => this.broadcast(userId, { type: "snapshot", snapshot }))
    viewer.on("event", (userId, event) => this.broadcast(userId, event))
    viewer.on("closed", userId => this.closeUser(userId))
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const requestUrl = new URL(request.url ?? "/", this.config.publicUrl)
    const path = requestUrl.pathname
    const origin = request.headers.origin
    if (path === "/api/viewer/control" && (!origin || !this.config.allowedOrigins.has(origin))) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
      return
    }
    if (path === "/api/viewer/stream" && origin !== "null" && (!origin || !this.config.allowedOrigins.has(origin))) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
      return
    }
    const context = this.authenticate(request)
    if (!context) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n")
      return
    }
    if (path === "/api/viewer/stream") {
      const token = requestUrl.searchParams.get("token")
      if (!token || !this.auth.verifySocketToken(token, context)) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n")
        return
      }
      this.viewerProxy.websocket(request, socket, head, context.user.id)
      return
    }
    if (path !== "/api/viewer/control") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n")
      return
    }
    this.server.handleUpgrade(request, socket, head, client => this.acceptControl(client, context))
  }

  private acceptControl(client: WebSocket, context: AuthContext) {
    let authenticated = false
    const timeout = setTimeout(() => client.close(4001, "Authentication timed out."), 5000)
    client.on("message", async data => {
      try {
        const message = JSON.parse(data.toString()) as { type: string; token?: string; command?: ViewerCommand }
        if (!authenticated) {
          if (message.type !== "authenticate" || !message.token || !this.auth.verifySocketToken(message.token, context)) {
            client.close(4001, "Authentication failed.")
            return
          }
          authenticated = true
          clearTimeout(timeout)
          const set = this.clients.get(context.user.id) ?? new Set<WebSocket>()
          set.add(client)
          this.clients.set(context.user.id, set)
          const snapshot = this.viewer.get(context.user.id)
          if (snapshot) {
            client.send(JSON.stringify({ type: "snapshot", snapshot } satisfies ViewerEvent))
          }
          return
        }
        this.viewer.touch(context.user.id)
        if (message.type === "command" && message.command) {
          await this.viewer.command(context, message.command)
        }
      } catch {
        client.send(JSON.stringify({ type: "error", error: { code: "VIEWER_MESSAGE_INVALID", message: "The viewer received an invalid command.", action: "Refresh the page and try again." } } satisfies ViewerEvent))
      }
    })
    client.on("close", () => {
      clearTimeout(timeout)
      const set = this.clients.get(context.user.id)
      set?.delete(client)
      if (set?.size === 0) {
        this.clients.delete(context.user.id)
      }
    })
  }

  private authenticate(request: IncomingMessage) {
    const cookies = Object.fromEntries((request.headers.cookie ?? "").split(";").map(value => value.trim()).filter(Boolean).map(value => {
      const index = value.indexOf("=")
      return index < 0 ? [value, ""] : [decodeURIComponent(value.slice(0, index)), decodeURIComponent(value.slice(index + 1))]
    }))
    return this.auth.authenticateToken(cookies[this.config.cookieName], request.headers["user-agent"] ?? "unknown")
  }

  private broadcast(userId: string, event: ViewerEvent) {
    for (const client of this.clients.get(userId) ?? []) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(event))
      }
    }
  }

  private closeUser(userId: string) {
    for (const client of this.clients.get(userId) ?? []) {
      client.close(1000, "The viewer session ended.")
    }
    this.clients.delete(userId)
  }
}
