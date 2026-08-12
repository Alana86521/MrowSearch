import { EventEmitter } from "node:events"
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import type { ClearDataRequest, PermissionKind, ViewerCommand, ViewerSnapshot } from "../../shared/contracts.js"
import type { AppConfig } from "../config.js"
import type { AppDatabase } from "../db/index.js"
import { persistentStorage, sitePermissions } from "../db/schema.js"
import { decryptText, encryptText, hmac } from "../lib/crypto.js"
import { ApiFault } from "../lib/errors.js"
import type { AuthContext } from "./auth.js"
import { WorkerClient } from "./worker-client.js"

interface Allocation {
  userId: string
  sessionId: string
  worker: WorkerClient
  lastLeaseAt: number
  lastActivityAt: number
  snapshot: ViewerSnapshot
}

export class ViewerService extends EventEmitter {
  private readonly workers: WorkerClient[]
  private readonly allocations = new Map<string, Allocation>()
  private readonly pollTimer: NodeJS.Timeout

  constructor(private readonly config: AppConfig, private readonly db: AppDatabase) {
    super()
    this.workers = config.workerDirectories.map((directory, index) => new WorkerClient(`worker-${index + 1}`, directory))
    this.pollTimer = setInterval(() => void this.poll(), 1000)
    this.pollTimer.unref()
  }

  async create(context: AuthContext) {
    const existing = this.allocations.get(context.user.id)
    if (existing) {
      existing.lastLeaseAt = Date.now()
      return existing.snapshot
    }
    const used = new Set([...this.allocations.values()].map(value => value.worker.id))
    let worker: WorkerClient | undefined
    for (const candidate of this.workers) {
      if (used.has(candidate.id) || !candidate.available()) {
        continue
      }
      try {
        const health = await candidate.health()
        if (health.ready && health.browserConnected) {
          worker = candidate
          break
        }
      } catch {}
    }
    if (!worker) {
      throw new ApiFault(503, { code: "VIEWER_CAPACITY_FULL", message: "No private viewer is available.", action: "Close another viewer or try again after an inactive session ends." })
    }
    const sessionId = randomUUID()
    let snapshot: ViewerSnapshot
    try {
      const storageState = context.user.privacyMode === "persistent" ? this.readPersistentState(context.user.id) : undefined
      snapshot = await worker.start({
        sessionId,
        userId: context.user.id,
        privacyMode: context.user.privacyMode,
        trackingLevel: context.user.trackingLevel,
        popupPolicy: context.user.popupPolicy,
        closedTabsEnabled: context.user.closedTabsEnabled,
        storageState,
        permissions: this.readPermissions(context.user.id)
      })
    } catch {
      throw new ApiFault(503, { code: "VIEWER_START_FAILED", message: "The private viewer did not start.", action: "Try again. If the failure continues, ask the owner to check browser worker health." })
    }
    const now = Date.now()
    const allocation = { userId: context.user.id, sessionId, worker, lastLeaseAt: now, lastActivityAt: now, snapshot }
    this.allocations.set(context.user.id, allocation)
    return snapshot
  }

  get(userId: string) {
    const allocation = this.allocations.get(userId)
    if (!allocation) {
      return null
    }
    allocation.lastLeaseAt = Date.now()
    return allocation.snapshot
  }

  getAllocation(userId: string) {
    return this.allocations.get(userId) ?? null
  }

  touch(userId: string) {
    const allocation = this.allocations.get(userId)
    if (allocation) {
      allocation.lastLeaseAt = Date.now()
      allocation.lastActivityAt = Date.now()
    }
  }

  async command(context: AuthContext, command: ViewerCommand) {
    const allocation = this.allocations.get(context.user.id)
    if (!allocation) {
      throw new ApiFault(409, { code: "VIEWER_NOT_ACTIVE", message: "The private viewer is not active.", action: "Open a result or start a new private tab." })
    }
    try {
      if (command.type === "set-permission") {
        if (["camera", "microphone"].includes(command.permission)) {
          throw new ApiFault(400, { code: "PERMISSION_ALWAYS_BLOCKED", message: "Camera and microphone access are always blocked.", action: "Use the site without camera or microphone input." })
        }
        const tab = allocation.snapshot.tabs.find(value => value.id === command.tabId)
        if (!tab?.currentUrl) {
          throw new ApiFault(400, { code: "PERMISSION_ORIGIN_MISSING", message: "The current tab has no site origin.", action: "Open a site before changing its permissions." })
        }
        this.writePermission(context.user.id, new URL(tab.currentUrl).origin, command.permission, command.decision)
      }
      const snapshot = await allocation.worker.command(command)
      allocation.snapshot = snapshot
      allocation.lastActivityAt = Date.now()
      allocation.lastLeaseAt = Date.now()
      this.emit("snapshot", context.user.id, snapshot)
      return snapshot
    } catch (error) {
      if (error instanceof ApiFault) {
        throw error
      }
      throw new ApiFault(502, { code: "VIEWER_COMMAND_FAILED", message: "The private viewer could not complete that action.", action: "Try again or clear the viewer session." })
    }
  }

  async clear(userId: string, full: boolean) {
    const allocation = this.allocations.get(userId)
    if (!allocation) {
      return
    }
    this.allocations.delete(userId)
    try {
      const result = await allocation.worker.clear(full)
      if (!full && result.storageState) {
        this.writePersistentState(userId, result.storageState)
      }
    } catch {}
    this.emit("closed", userId)
  }

  async clearData(userId: string, request: ClearDataRequest) {
    const allocation = this.allocations.get(userId)
    if (!allocation) return
    const snapshot = await allocation.worker.clearData(request)
    allocation.snapshot = snapshot
    allocation.lastActivityAt = Date.now()
    allocation.lastLeaseAt = Date.now()
    this.emit("snapshot", userId, snapshot)
  }

  async upload(context: AuthContext, tabId: string, filename: string, mimeType: string, data: Buffer) {
    const allocation = this.allocations.get(context.user.id)
    if (!allocation) {
      throw new ApiFault(409, { code: "VIEWER_NOT_ACTIVE", message: "The private viewer is not active.", action: "Start the viewer before uploading a file." })
    }
    return allocation.worker.upload(tabId, filename, mimeType, data)
  }

  async download(context: AuthContext, fileId: string) {
    const allocation = this.allocations.get(context.user.id)
    if (!allocation) {
      throw new ApiFault(404, { code: "DOWNLOAD_NOT_FOUND", message: "The download is no longer available.", action: "Start the download again from the site." })
    }
    return allocation.worker.download(fileId)
  }

  async audio(context: AuthContext) {
    const allocation = this.allocations.get(context.user.id)
    if (!allocation) {
      throw new ApiFault(409, { code: "VIEWER_NOT_ACTIVE", message: "The private viewer is not active.", action: "Start the viewer before enabling audio." })
    }
    allocation.lastLeaseAt = Date.now()
    return allocation.worker.audio()
  }

  async health() {
    return Promise.all(this.workers.map(async worker => {
      try {
        return { id: worker.id, directory: worker.directory, ...(await worker.health()) }
      } catch {
        return { id: worker.id, directory: worker.directory, ready: false, browserConnected: false, sessionId: null }
      }
    }))
  }

  async close() {
    clearInterval(this.pollTimer)
    await Promise.all([...this.allocations.keys()].map(userId => this.clear(userId, false)))
  }

  private async poll() {
    const now = Date.now()
    for (const allocation of [...this.allocations.values()]) {
      if (now - allocation.lastLeaseAt > this.config.viewerLeaseSeconds * 1000 || now - allocation.lastActivityAt > this.config.viewerIdleSeconds * 1000) {
        await this.clear(allocation.userId, false)
        continue
      }
      try {
        const snapshot = await allocation.worker.state()
        const pending = await allocation.worker.events()
        for (const event of pending.events) {
          this.emit("event", allocation.userId, event)
        }
        if (JSON.stringify(snapshot) !== JSON.stringify(allocation.snapshot)) {
          allocation.snapshot = snapshot
          this.emit("snapshot", allocation.userId, snapshot)
        }
      } catch {
        await this.clear(allocation.userId, false)
      }
    }
  }

  private readPersistentState(userId: string) {
    const originHash = hmac("browser-profile", this.config.dataKey)
    const row = this.db.select().from(persistentStorage).where(eq(persistentStorage.userId, userId)).all().find(value => value.originHash === originHash)
    if (!row) {
      return undefined
    }
    try {
      return decryptText(row.encryptedPayload, this.config.dataKey, `user:${userId}:browser-profile:${row.schemaVersion}`)
    } catch {
      return undefined
    }
  }

  private writePersistentState(userId: string, storageState: string) {
    const originHash = hmac("browser-profile", this.config.dataKey)
    const schemaVersion = 1
    this.db.insert(persistentStorage).values({
      userId,
      originHash,
      originCipher: encryptText("browser-profile", this.config.dataKey, `user:${userId}:origin:${schemaVersion}`),
      encryptedPayload: encryptText(storageState, this.config.dataKey, `user:${userId}:browser-profile:${schemaVersion}`),
      updatedAt: Date.now(),
      schemaVersion
    }).onConflictDoUpdate({
      target: [persistentStorage.userId, persistentStorage.originHash],
      set: {
        originCipher: encryptText("browser-profile", this.config.dataKey, `user:${userId}:origin:${schemaVersion}`),
        encryptedPayload: encryptText(storageState, this.config.dataKey, `user:${userId}:browser-profile:${schemaVersion}`),
        updatedAt: Date.now(),
        schemaVersion
      }
    }).run()
  }

  private readPermissions(userId: string) {
    return this.db.select().from(sitePermissions).where(eq(sitePermissions.userId, userId)).all().flatMap(row => {
      if (!(["location", "notifications", "clipboard-read", "clipboard-write"] as string[]).includes(row.kind) || !(["block", "allow-site"] as string[]).includes(row.decision) || row.expiresAt && row.expiresAt < Date.now()) {
        return []
      }
      try {
        const origin = decryptText(row.originCipher, this.config.dataKey, `user:${userId}:permission-origin:${row.kind}:1`)
        return [{ origin, permission: row.kind as "location" | "notifications" | "clipboard-read" | "clipboard-write", decision: row.decision as "block" | "allow-site" }]
      } catch {
        return []
      }
    })
  }

  private writePermission(userId: string, origin: string, kind: PermissionKind, decision: "block" | "allow-once" | "allow-site") {
    if (decision === "allow-once") {
      return
    }
    const originHash = hmac(`${origin}:${kind}`, this.config.dataKey)
    this.db.insert(sitePermissions).values({
      userId,
      originHash,
      originCipher: encryptText(origin, this.config.dataKey, `user:${userId}:permission-origin:${kind}:1`),
      kind,
      decision,
      lastUsedAt: Date.now(),
      expiresAt: null
    }).onConflictDoUpdate({ target: [sitePermissions.userId, sitePermissions.originHash, sitePermissions.kind], set: { decision, lastUsedAt: Date.now(), expiresAt: null } }).run()
  }
}
