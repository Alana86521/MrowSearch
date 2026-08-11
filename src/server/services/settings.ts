import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { request as httpRequest } from "node:http"
import { z } from "zod"
import type { AppConfig } from "../config.js"

export const egressSettingsSchema = z.object({
  dnsMode: z.enum(["system", "custom", "doh", "dot"]),
  dnsEndpoint: z.string().max(512),
  allowedPorts: z.array(z.number().int().min(1).max(65535)).max(32)
})

export type EgressSettings = z.infer<typeof egressSettingsSchema>

export class SettingsService {
  constructor(private readonly config: AppConfig) {
    mkdirSync(dirname(config.egressSettingsPath), { recursive: true })
  }

  read(): EgressSettings {
    try {
      return this.normalize(egressSettingsSchema.parse(JSON.parse(readFileSync(this.config.egressSettingsPath, "utf8"))))
    } catch {
      return { dnsMode: "system", dnsEndpoint: "", allowedPorts: [80, 443] }
    }
  }

  write(value: EgressSettings) {
    const settings = this.normalize(egressSettingsSchema.parse(value))
    this.validateEndpoint(settings)
    const temporaryPath = `${this.config.egressSettingsPath}.new`
    writeFileSync(temporaryPath, JSON.stringify(settings), { encoding: "utf8", mode: 0o600 })
    renameSync(temporaryPath, this.config.egressSettingsPath)
    return settings
  }

  async diagnostics() {
    const settings = this.read()
    const probes = await Promise.allSettled([
      fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(5000) }).then(response => response.ok ? response.json() as Promise<{ ip: string }> : Promise.reject(new Error())),
      fetch("https://api64.ipify.org?format=json", { signal: AbortSignal.timeout(5000) }).then(response => response.ok ? response.json() as Promise<{ ip: string }> : Promise.reject(new Error()))
    ])
    const addresses = [...new Set(probes.flatMap(probe => probe.status === "fulfilled" ? [probe.value.ip] : []))]
    const resolverStatus = await this.testEgress()
    return {
      settings,
      outboundAddresses: addresses,
      resolverStatus,
      checkedAt: Date.now()
    }
  }

  private testEgress() {
    return new Promise<"passed" | "failed">(resolve => {
      const request = httpRequest({ socketPath: this.config.egressSocket, method: "HEAD", path: "http://example.com/", headers: { host: "example.com" } }, response => {
        response.resume()
        resolve(response.statusCode && response.statusCode < 500 ? "passed" : "failed")
      })
      request.setTimeout(5000, () => request.destroy())
      request.on("error", () => resolve("failed"))
      request.end()
    })
  }

  private normalize(value: EgressSettings): EgressSettings {
    return { ...value, dnsEndpoint: value.dnsEndpoint.trim(), allowedPorts: [...new Set([80, 443, ...value.allowedPorts])].sort((a, b) => a - b) }
  }

  private validateEndpoint(value: EgressSettings) {
    if (value.dnsMode === "system") {
      return
    }
    if (!value.dnsEndpoint) {
      throw new Error("The selected DNS mode needs a resolver endpoint.")
    }
    if (value.dnsMode === "doh" && new URL(value.dnsEndpoint).protocol !== "https:") {
      throw new Error("The DNS over HTTPS endpoint must use HTTPS.")
    }
  }
}
