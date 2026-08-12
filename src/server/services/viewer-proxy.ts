import { request as httpRequest, type IncomingMessage } from "node:http"
import { connect as connectSocket } from "node:net"
import type { Duplex } from "node:stream"
import type { FastifyReply, FastifyRequest } from "fastify"
import type { AppConfig } from "../config.js"
import { ApiFault } from "../lib/errors.js"
import type { AuthService } from "./auth.js"
import type { ViewerService } from "./viewer.js"

export class ViewerProxy {
  constructor(private readonly auth: AuthService, private readonly viewer: ViewerService, private readonly config: AppConfig) {}

  async http(request: FastifyRequest, reply: FastifyReply) {
    const context = this.auth.requireRequest(request)
    const allocation = this.viewer.getAllocation(context.user.id)
    if (!allocation) {
      throw new ApiFault(409, { code: "VIEWER_NOT_ACTIVE", message: "The private viewer is not active.", action: "Open a result or start a private tab." })
    }
    const sourceUrl = new URL(request.raw.url ?? "/", this.config.publicUrl)
    const path = sourceUrl.pathname.replace(/^\/api\/viewer\/kasm/, "") || "/"
    const targetPath = `${path}${sourceUrl.search}`
    return new Promise<void>((resolve, reject) => {
      const upstream = httpRequest({
        socketPath: allocation.worker.kasmSocket,
        path: targetPath,
        method: request.method,
        headers: {
          accept: request.headers.accept ?? "*/*",
          "accept-language": request.headers["accept-language"] ?? "en-US,en;q=0.8",
          "accept-encoding": "identity",
          authorization: `Basic ${Buffer.from(`kasm_user:${this.config.workerPassword}`).toString("base64")}`,
          host: "127.0.0.1:6901"
        }
      }, response => {
        const contentType = String(response.headers["content-type"] ?? "application/octet-stream")
        const headers = { ...response.headers }
        delete headers["www-authenticate"]
        delete headers["content-length"]
        delete headers["content-security-policy"]
        delete headers["x-frame-options"]
        for (const [name, value] of Object.entries(headers)) {
          if (value !== undefined) {
            reply.header(name, value)
          }
        }
        reply.header("cache-control", contentType.includes("text/html") ? "no-store" : "private, max-age=3600")
        reply.header("content-security-policy", "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; frame-ancestors 'self'; form-action 'self'")
        reply.status(response.statusCode ?? 502)
        if (contentType.includes("text/html") || contentType.includes("text/css")) {
          const chunks: Buffer[] = []
          response.on("data", chunk => chunks.push(Buffer.from(chunk)))
          response.on("end", () => {
            const source = Buffer.concat(chunks).toString("utf8")
            const rewritten = source
              .replaceAll('href="/', 'href="/api/viewer/kasm/')
              .replaceAll('src="/', 'src="/api/viewer/kasm/')
              .replaceAll("url('/", "url('/api/viewer/kasm/")
              .replaceAll('url("/', 'url("/api/viewer/kasm/')
            reply.send(rewritten)
            resolve()
          })
          return
        }
        reply.send(response)
        response.on("end", resolve)
      })
      upstream.on("error", reject)
      request.raw.pipe(upstream)
    })
  }

  websocket(request: IncomingMessage, client: Duplex, head: Buffer, contextUserId: string) {
    const allocation = this.viewer.getAllocation(contextUserId)
    if (!allocation) {
      this.rejectUpgrade(client, 409, "The private viewer is not active.")
      return
    }
    const upstream = connectSocket(allocation.worker.kasmSocket)
    upstream.once("connect", () => {
      const requestHeaders = this.buildUpgradeHeaders(request)
      upstream.write(`GET /websockify HTTP/1.1\r\n${requestHeaders}\r\n\r\n`)
      if (head.length > 0) {
        upstream.write(head)
      }
      upstream.pipe(client)
      client.pipe(upstream)
    })
    upstream.on("error", () => this.rejectUpgrade(client, 502, "The private viewer stream is unavailable."))
    client.on("error", () => upstream.destroy())
  }

  private buildUpgradeHeaders(request: IncomingMessage) {
    const headers = new Map<string, string>()
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || ["host", "authorization", "cookie"].includes(name)) {
        continue
      }
      headers.set(name, Array.isArray(value) ? value.join(", ") : value)
    }
    headers.set("host", "127.0.0.1:6901")
    headers.set("authorization", `Basic ${Buffer.from(`kasm_user:${this.config.workerPassword}`).toString("base64")}`)
    return [...headers.entries()].map(([name, value]) => `${name}: ${value}`).join("\r\n")
  }

  private rejectUpgrade(socket: Duplex, status: number, message: string) {
    if (socket.destroyed) {
      return
    }
    const body = Buffer.from(message)
    socket.end(`HTTP/1.1 ${status} Error\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${body.length}\r\n\r\n${message}`)
  }
}
