import { promises as dnsPromises } from "node:dns"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, watchFile } from "node:fs"
import { createServer, request as requestHttp } from "node:http"
import { connect as connectTcp } from "node:net"
import { dirname } from "node:path"
import { randomInt } from "node:crypto"
import { connect as connectTls } from "node:tls"
import ipaddr from "ipaddr.js"
import { parseAuthority, validateAddress, validateHostname, validateResolvedAddresses } from "./security.js"

interface EgressSettings {
  dnsMode: "system" | "custom" | "doh" | "dot"
  dnsEndpoint: string
  allowedPorts: number[]
}

const socketPath = process.env.MROW_EGRESS_SOCKET ?? "/run/mrow-egress/proxy.sock"
const settingsPath = process.env.MROW_EGRESS_SETTINGS_PATH ?? "/data/egress-settings.json"
const defaultSettings: EgressSettings = { dnsMode: "system", dnsEndpoint: "", allowedPorts: [80, 443] }
let settings = loadSettings()

mkdirSync(dirname(socketPath), { recursive: true })
if (existsSync(socketPath)) {
  rmSync(socketPath)
}
watchFile(settingsPath, { interval: 5000 }, () => {
  settings = loadSettings()
})

function loadSettings(): EgressSettings {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as Partial<EgressSettings>
    const dnsMode = ["system", "custom", "doh", "dot"].includes(parsed.dnsMode ?? "") ? parsed.dnsMode as EgressSettings["dnsMode"] : "system"
    const allowedPorts = [...new Set([80, 443, ...(parsed.allowedPorts ?? [])])].filter(port => Number.isInteger(port) && port >= 1 && port <= 65535)
    return { dnsMode, dnsEndpoint: parsed.dnsEndpoint ?? "", allowedPorts }
  } catch {
    return defaultSettings
  }
}

async function resolveHost(hostname: string) {
  if (ipaddr.isValid(hostname)) {
    return [validateAddress(hostname)]
  }
  const host = validateHostname(hostname)
  let values: string[]
  if (settings.dnsMode === "custom") {
    const resolver = new dnsPromises.Resolver()
    resolver.setServers(settings.dnsEndpoint.split(",").map(value => value.trim()).filter(Boolean))
    const [ipv4, ipv6] = await Promise.all([resolver.resolve4(host).catch(() => []), resolver.resolve6(host).catch(() => [])])
    values = [...ipv4, ...ipv6]
  } else if (settings.dnsMode === "doh") {
    values = await resolveDoh(host)
  } else if (settings.dnsMode === "dot") {
    values = await resolveDot(host)
  } else {
    const records = await dnsPromises.lookup(host, { all: true, verbatim: true })
    values = records.map(record => record.address)
  }
  return validateResolvedAddresses(values)
}

function encodeDnsName(name: string) {
  const parts = name.split(".")
  const buffers = parts.map(part => {
    const value = Buffer.from(part, "ascii")
    return Buffer.concat([Buffer.from([value.length]), value])
  })
  return Buffer.concat([...buffers, Buffer.from([0])])
}

function skipDnsName(buffer: Buffer, start: number) {
  let offset = start
  while (offset < buffer.length) {
    const length = buffer[offset]
    if ((length & 0xc0) === 0xc0) {
      return offset + 2
    }
    offset += 1
    if (length === 0) {
      return offset
    }
    offset += length
  }
  throw new Error("The DNS response name is invalid.")
}

function parseDnsAddresses(buffer: Buffer) {
  if (buffer.length < 12) {
    return []
  }
  const questionCount = buffer.readUInt16BE(4)
  const answerCount = buffer.readUInt16BE(6)
  let offset = 12
  for (let index = 0; index < questionCount; index += 1) {
    offset = skipDnsName(buffer, offset) + 4
  }
  const values: string[] = []
  for (let index = 0; index < answerCount && offset < buffer.length; index += 1) {
    offset = skipDnsName(buffer, offset)
    const type = buffer.readUInt16BE(offset)
    const dataLength = buffer.readUInt16BE(offset + 8)
    offset += 10
    if (type === 1 && dataLength === 4) {
      values.push([...buffer.subarray(offset, offset + 4)].join("."))
    }
    if (type === 28 && dataLength === 16) {
      const groups: string[] = []
      for (let group = 0; group < 8; group += 1) {
        groups.push(buffer.readUInt16BE(offset + group * 2).toString(16))
      }
      values.push(groups.join(":"))
    }
    offset += dataLength
  }
  return values
}

async function queryDot(hostname: string, type: 1 | 28) {
  const endpoint = settings.dnsEndpoint.includes("://") ? new URL(settings.dnsEndpoint) : new URL(`tls://${settings.dnsEndpoint}`)
  const resolverHost = endpoint.hostname
  const resolverPort = Number(endpoint.port || 853)
  const servername = endpoint.searchParams.get("servername") || resolverHost
  const id = randomInt(0, 65536)
  const header = Buffer.alloc(12)
  header.writeUInt16BE(id, 0)
  header.writeUInt16BE(0x0100, 2)
  header.writeUInt16BE(1, 4)
  const questionTail = Buffer.alloc(4)
  questionTail.writeUInt16BE(type, 0)
  questionTail.writeUInt16BE(1, 2)
  const query = Buffer.concat([header, encodeDnsName(hostname), questionTail])
  const frame = Buffer.alloc(query.length + 2)
  frame.writeUInt16BE(query.length, 0)
  query.copy(frame, 2)
  return new Promise<string[]>((resolve, reject) => {
    const socket = connectTls({ host: resolverHost, port: resolverPort, servername, rejectUnauthorized: true })
    const chunks: Buffer[] = []
    let expected = -1
    const timer = setTimeout(() => socket.destroy(new Error("The DNS over TLS request timed out.")), 5000)
    socket.once("secureConnect", () => socket.write(frame))
    socket.on("data", chunk => {
      chunks.push(Buffer.from(chunk))
      const data = Buffer.concat(chunks)
      if (expected < 0 && data.length >= 2) {
        expected = data.readUInt16BE(0)
      }
      if (expected >= 0 && data.length >= expected + 2) {
        clearTimeout(timer)
        socket.end()
        resolve(parseDnsAddresses(data.subarray(2, expected + 2)))
      }
    })
    socket.on("error", error => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function resolveDot(hostname: string) {
  const [ipv4, ipv6] = await Promise.all([queryDot(hostname, 1).catch(() => []), queryDot(hostname, 28).catch(() => [])])
  return [...ipv4, ...ipv6]
}

async function resolveDoh(hostname: string) {
  const endpoint = new URL(settings.dnsEndpoint)
  if (endpoint.protocol !== "https:") {
    throw new Error("The DNS over HTTPS endpoint must use HTTPS.")
  }
  const values: string[] = []
  for (const type of ["A", "AAAA"]) {
    const url = new URL(endpoint)
    url.searchParams.set("name", hostname)
    url.searchParams.set("type", type)
    const response = await fetch(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(5000) })
    if (!response.ok) {
      continue
    }
    const data = await response.json() as { Answer?: Array<{ type: number; data: string }> }
    values.push(...(data.Answer ?? []).filter(answer => answer.type === 1 || answer.type === 28).map(answer => answer.data))
  }
  return values
}

const proxy = createServer(async (request, response) => {
  try {
    if (!request.url) {
      throw new Error("The destination URL is missing.")
    }
    const target = new URL(request.url)
    if (target.protocol !== "http:") {
      throw new Error("The proxy accepts direct requests through HTTP only.")
    }
    const port = Number(target.port || 80)
    if (!settings.allowedPorts.includes(port)) {
      throw new Error("The destination port is not allowed.")
    }
    const addresses = await resolveHost(target.hostname)
    const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !["proxy-authorization", "proxy-connection", "x-forwarded-for", "forwarded", "via", "connection", "host"].includes(name)))
    const upstream = requestHttp({ host: addresses[0], port, method: request.method, path: `${target.pathname}${target.search}`, headers: { ...headers, host: target.host }, agent: false }, upstreamResponse => {
      const responseHeaders = Object.fromEntries(Object.entries(upstreamResponse.headers).filter(([name]) => !["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"].includes(name)))
      response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders)
      upstreamResponse.pipe(response)
    })
    upstream.on("error", () => response.destroy())
    request.pipe(upstream)
  } catch (error) {
    response.writeHead(403, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" })
    response.end(error instanceof Error ? error.message : "The destination is blocked.")
  }
})

proxy.on("connect", async (request, client, head) => {
  try {
    const { hostname, port } = parseAuthority(request.url ?? "")
    if (!settings.allowedPorts.includes(port)) {
      throw new Error("The destination port is not allowed.")
    }
    const addresses = await resolveHost(hostname)
    const upstream = connectTcp({ host: addresses[0], port })
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: MrowSearch\r\n\r\n")
      if (head.length > 0) {
        upstream.write(head)
      }
      upstream.pipe(client)
      client.pipe(upstream)
    })
    upstream.on("error", () => client.destroy())
    client.on("error", () => upstream.destroy())
  } catch (error) {
    const message = error instanceof Error ? error.message : "The destination is blocked."
    client.end(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`)
  }
})

proxy.listen(socketPath, () => {
  chmodSync(socketPath, 0o660)
  process.stdout.write("egress-ready\n")
})
