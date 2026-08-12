import { randomUUID } from "node:crypto"
import argon2 from "argon2"
import { and, eq, lt, or } from "drizzle-orm"
import * as OTPAuth from "otpauth"
import type { FastifyRequest } from "fastify"
import { parseSearchEngines, type SessionUser } from "../../shared/contracts.js"
import type { AppConfig } from "../config.js"
import type { AppDatabase } from "../db/index.js"
import { auditEvents, invites, loginChallenges, passwordResets, recoveryCodes, sessions, users } from "../db/schema.js"
import { decryptText, encryptText, hmac, randomToken, safeEqual, sha256 } from "../lib/crypto.js"
import { ApiFault, invalidRequest, notAuthenticated, notAuthorized } from "../lib/errors.js"

const passwordOptions = {
  type: argon2.argon2id as 2,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1
}

const usernamePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/

type UserRow = typeof users.$inferSelect
type SessionRow = typeof sessions.$inferSelect

export interface AuthContext {
  session: SessionRow
  user: UserRow
}

export class AuthService {
  constructor(private readonly db: AppDatabase, private readonly config: AppConfig) {}

  setupRequired() {
    const row = this.db.select({ id: users.id }).from(users).where(eq(users.role, "owner")).get()
    return !row
  }

  validateCredentials(username: string, password: string) {
    if (!usernamePattern.test(username)) {
      throw invalidRequest("The username must contain 3 to 32 letters, numbers, underscores, or hyphens.", "Choose a different username.", { username: "Use 3 to 32 supported characters." })
    }
    if (password.length < 12 || password.length > 128) {
      throw invalidRequest("The password must contain 12 to 128 characters.", "Choose a longer password.", { password: "Use 12 to 128 characters." })
    }
  }

  async setupOwner(setupToken: string, username: string, password: string, userAgent: string) {
    if (!this.setupRequired()) {
      throw new ApiFault(409, { code: "SETUP_COMPLETE", message: "The owner account already exists.", action: "Sign in with the owner account." })
    }
    if (!safeEqual(setupToken, this.config.setupToken)) {
      throw new ApiFault(403, { code: "SETUP_TOKEN_INVALID", message: "The setup token is not valid.", action: "Use the token from the CasaOS application settings." })
    }
    this.validateCredentials(username, password)
    const now = Date.now()
    const id = randomUUID()
    const passwordHash = await argon2.hash(password, passwordOptions)
    this.db.transaction(tx => {
      const existing = tx.select({ id: users.id }).from(users).where(eq(users.role, "owner")).get()
      if (existing) {
        throw new ApiFault(409, { code: "SETUP_COMPLETE", message: "The owner account already exists.", action: "Sign in with the owner account." })
      }
      tx.insert(users).values({
        id,
        username,
        passwordHash,
        role: "owner",
        status: "active",
        createdAt: now,
        approvedAt: now,
        approvedBy: id,
        passwordChangedAt: now
      }).run()
      tx.insert(auditEvents).values({ id: randomUUID(), userId: id, actorId: id, event: "owner-created", createdAt: now }).run()
    })
    return this.createSession(id, userAgent)
  }

  async login(username: string, password: string, userAgent: string) {
    const user = this.db.select().from(users).where(eq(users.username, username)).get()
    const dummyHash = "$argon2id$v=19$m=19456,t=2,p=1$ZGVmYXVsdC1zYWx0LXZhbHVl$V5ZkcmGAlDGNv2/XWmiWyBlf/2oSg6dKUHJgzRVTe2Q"
    const valid = await argon2.verify(user?.passwordHash ?? dummyHash, password).catch(() => false)
    if (!user || !valid) {
      throw new ApiFault(401, { code: "SIGN_IN_FAILED", message: "The username or password is not correct.", action: "Check both values and try again." })
    }
    if (user.status === "pending") {
      throw new ApiFault(403, { code: "ACCOUNT_PENDING", message: "The owner has not approved this account.", action: "Wait for the owner to approve the account." })
    }
    if (user.status === "disabled") {
      throw new ApiFault(403, { code: "ACCOUNT_DISABLED", message: "The owner disabled this account.", action: "Ask the owner to restore access." })
    }
    if (user.totpEnabled) {
      const rawToken = randomToken()
      const now = Date.now()
      this.db.insert(loginChallenges).values({ id: sha256(rawToken), userId: user.id, createdAt: now, expiresAt: now + 300000, attempts: 0 }).run()
      return { challengeToken: rawToken, requiresTotp: true as const }
    }
    return { ...(this.createSession(user.id, userAgent)), requiresTotp: false as const }
  }

  completeTotp(challengeToken: string, code: string, userAgent: string) {
    const challengeId = sha256(challengeToken)
    const challenge = this.db.select().from(loginChallenges).where(eq(loginChallenges.id, challengeId)).get()
    const now = Date.now()
    if (!challenge || challenge.expiresAt <= now || challenge.attempts >= 5) {
      throw new ApiFault(401, { code: "TOTP_CHALLENGE_EXPIRED", message: "The verification request expired.", action: "Sign in again." })
    }
    const user = this.db.select().from(users).where(eq(users.id, challenge.userId)).get()
    if (!user?.totpSecret || !user.totpEnabled) {
      throw new ApiFault(401, { code: "TOTP_NOT_AVAILABLE", message: "Authenticator verification is not available.", action: "Sign in again." })
    }
    this.db.update(loginChallenges).set({ attempts: challenge.attempts + 1 }).where(eq(loginChallenges.id, challenge.id)).run()
    const secret = decryptText(user.totpSecret, this.config.dataKey, `totp:${user.id}:1`)
    if (!this.verifyTotp(secret, code)) {
      throw new ApiFault(401, { code: "TOTP_INVALID", message: "The authenticator code is not correct.", action: "Use the newest code and try again." })
    }
    this.db.delete(loginChallenges).where(eq(loginChallenges.id, challenge.id)).run()
    return this.createSession(user.id, userAgent)
  }

  completeRecovery(challengeToken: string, code: string, userAgent: string) {
    const challenge = this.db.select().from(loginChallenges).where(eq(loginChallenges.id, sha256(challengeToken))).get()
    const now = Date.now()
    if (!challenge || challenge.expiresAt <= now || challenge.attempts >= 5) {
      throw new ApiFault(401, { code: "RECOVERY_CHALLENGE_EXPIRED", message: "The recovery request expired.", action: "Sign in again." })
    }
    const codeHash = hmac(code.replaceAll("-", "").toUpperCase(), this.config.dataKey)
    const recovery = this.db.select().from(recoveryCodes).where(and(eq(recoveryCodes.userId, challenge.userId), eq(recoveryCodes.codeHash, codeHash))).get()
    if (!recovery || recovery.usedAt) {
      this.db.update(loginChallenges).set({ attempts: challenge.attempts + 1 }).where(eq(loginChallenges.id, challenge.id)).run()
      throw new ApiFault(401, { code: "RECOVERY_CODE_INVALID", message: "The recovery code is not valid.", action: "Use an unused recovery code." })
    }
    this.db.transaction(tx => {
      tx.update(recoveryCodes).set({ usedAt: now }).where(eq(recoveryCodes.id, recovery.id)).run()
      tx.delete(loginChallenges).where(eq(loginChallenges.id, challenge.id)).run()
    })
    return this.createSession(challenge.userId, userAgent)
  }

  createSession(userId: string, userAgent: string) {
    const token = randomToken()
    const csrfToken = randomToken()
    const now = Date.now()
    this.db.insert(sessions).values({
      id: sha256(token),
      userId,
      csrfHash: sha256(csrfToken),
      createdAt: now,
      lastSeenAt: now,
      idleExpiresAt: now + this.config.idleSessionSeconds * 1000,
      absoluteExpiresAt: now + this.config.absoluteSessionSeconds * 1000,
      userAgentHash: sha256(userAgent)
    }).run()
    return { sessionToken: token, csrfToken }
  }

  authenticateToken(token: string | undefined, userAgent: string, touch = true) {
    if (!token) {
      return null
    }
    const session = this.db.select().from(sessions).where(eq(sessions.id, sha256(token))).get()
    const now = Date.now()
    if (!session || session.idleExpiresAt <= now || session.absoluteExpiresAt <= now) {
      if (session) {
        this.db.delete(sessions).where(eq(sessions.id, session.id)).run()
      }
      return null
    }
    if (!safeEqual(session.userAgentHash, sha256(userAgent))) {
      return null
    }
    const user = this.db.select().from(users).where(eq(users.id, session.userId)).get()
    if (!user || user.status !== "active") {
      return null
    }
    if (touch && now - session.lastSeenAt > 60000) {
      this.db.update(sessions).set({ lastSeenAt: now, idleExpiresAt: now + this.config.idleSessionSeconds * 1000 }).where(eq(sessions.id, session.id)).run()
      session.lastSeenAt = now
      session.idleExpiresAt = now + this.config.idleSessionSeconds * 1000
    }
    return { session, user } satisfies AuthContext
  }

  authenticateRequest(request: FastifyRequest, touch = true) {
    return this.authenticateToken(request.cookies[this.config.cookieName], request.headers["user-agent"] ?? "unknown", touch)
  }

  requireRequest(request: FastifyRequest) {
    const context = this.authenticateRequest(request)
    if (!context) {
      throw notAuthenticated()
    }
    return context
  }

  requireOwner(request: FastifyRequest) {
    const context = this.requireRequest(request)
    if (context.user.role !== "owner") {
      throw notAuthorized()
    }
    return context
  }

  rotateCsrf(context: AuthContext) {
    const csrfToken = randomToken()
    this.db.update(sessions).set({ csrfHash: sha256(csrfToken) }).where(eq(sessions.id, context.session.id)).run()
    context.session.csrfHash = sha256(csrfToken)
    return csrfToken
  }

  verifyCsrf(request: FastifyRequest, context: AuthContext) {
    const token = request.headers["x-csrf-token"]
    if (typeof token !== "string" || !safeEqual(context.session.csrfHash, sha256(token))) {
      throw new ApiFault(403, { code: "CSRF_INVALID", message: "The security token is missing or expired.", action: "Refresh the page and try again." })
    }
  }

  destroySession(context: AuthContext) {
    this.db.delete(sessions).where(eq(sessions.id, context.session.id)).run()
  }

  destroyUserSessions(userId: string) {
    this.db.delete(sessions).where(eq(sessions.userId, userId)).run()
  }

  createSocketToken(context: AuthContext) {
    const payload = Buffer.from(JSON.stringify({ sessionId: context.session.id, userId: context.user.id, expiresAt: Date.now() + 60000, nonce: randomToken(12) })).toString("base64url")
    return `${payload}.${hmac(payload, this.config.sessionSecret)}`
  }

  verifySocketToken(value: string, context: AuthContext) {
    const [payload, signature] = value.split(".")
    if (!payload || !signature || !safeEqual(signature, hmac(payload, this.config.sessionSecret))) {
      return false
    }
    try {
      const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sessionId: string; userId: string; expiresAt: number }
      return parsed.sessionId === context.session.id && parsed.userId === context.user.id && parsed.expiresAt > Date.now()
    } catch {
      return false
    }
  }

  asSessionUser(user: UserRow): SessionUser {
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      totpEnabled: user.totpEnabled,
      safeSearch: user.safeSearch as 0 | 1 | 2,
      searchEngines: parseSearchEngines(user.searchEngines),
      privacyMode: user.privacyMode,
      historyMode: user.historyMode,
      trackingLevel: user.trackingLevel,
      popupPolicy: user.popupPolicy,
      closedTabsEnabled: user.closedTabsEnabled,
      clearOnLogout: user.clearOnLogout,
      clearOnTabClose: user.clearOnTabClose
    }
  }

  startTotp(context: AuthContext) {
    if (context.user.totpEnabled) {
      throw new ApiFault(409, { code: "TOTP_ALREADY_ENABLED", message: "Authenticator protection is already enabled.", action: "Use the existing authenticator or ask the owner for an account reset." })
    }
    const secret = new OTPAuth.Secret({ size: 20 })
    const encoded = secret.base32
    const encrypted = encryptText(encoded, this.config.dataKey, `totp:${context.user.id}:1`)
    this.db.update(users).set({ totpSecret: encrypted, totpEnabled: false }).where(eq(users.id, context.user.id)).run()
    const totp = new OTPAuth.TOTP({ issuer: "MrowSearch", label: context.user.username, algorithm: "SHA1", digits: 6, period: 30, secret })
    return { uri: totp.toString(), secret: encoded }
  }

  confirmTotp(context: AuthContext, code: string) {
    const user = this.db.select().from(users).where(eq(users.id, context.user.id)).get()
    if (!user?.totpSecret) {
      throw new ApiFault(409, { code: "TOTP_SETUP_MISSING", message: "Authenticator setup has not started.", action: "Start authenticator setup again." })
    }
    const secret = decryptText(user.totpSecret, this.config.dataKey, `totp:${user.id}:1`)
    if (!this.verifyTotp(secret, code)) {
      throw new ApiFault(400, { code: "TOTP_INVALID", message: "The authenticator code is not correct.", action: "Use the newest code and try again." })
    }
    const codes = Array.from({ length: 10 }, () => `${randomToken(6).slice(0, 6)}-${randomToken(6).slice(0, 6)}`.toUpperCase())
    const now = Date.now()
    this.db.transaction(tx => {
      tx.update(users).set({ totpEnabled: true }).where(eq(users.id, user.id)).run()
      tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, user.id)).run()
      tx.insert(recoveryCodes).values(codes.map(codeValue => ({ id: randomUUID(), userId: user.id, codeHash: hmac(codeValue.replaceAll("-", ""), this.config.dataKey), usedAt: null }))).run()
      tx.insert(auditEvents).values({ id: randomUUID(), userId: user.id, actorId: user.id, event: "totp-enabled", createdAt: now }).run()
    })
    return codes
  }

  verifyTotp(secret: string, code: string) {
    const totp = new OTPAuth.TOTP({ algorithm: "SHA1", digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) })
    return totp.validate({ token: code.replaceAll(" ", ""), window: 1 }) !== null
  }

  createInvite(owner: AuthContext) {
    const token = randomToken(24)
    const now = Date.now()
    const expiresAt = now + 7 * 24 * 60 * 60 * 1000
    this.db.insert(invites).values({ id: randomUUID(), tokenHash: sha256(token), createdBy: owner.user.id, createdAt: now, expiresAt }).run()
    this.audit(owner.user.id, owner.user.id, "invite-created")
    return { code: token, expiresAt }
  }

  async registerInvite(code: string, username: string, password: string) {
    this.validateCredentials(username, password)
    const invite = this.db.select().from(invites).where(eq(invites.tokenHash, sha256(code))).get()
    const now = Date.now()
    if (!invite || invite.expiresAt <= now || invite.usedAt) {
      throw new ApiFault(400, { code: "INVITE_INVALID", message: "The invite code is invalid, expired, or already used.", action: "Ask the owner for a new invite code." })
    }
    if (this.db.select({ id: users.id }).from(users).where(eq(users.username, username)).get()) {
      throw new ApiFault(409, { code: "USERNAME_TAKEN", message: "That username is already in use.", action: "Choose a different username." })
    }
    const passwordHash = await argon2.hash(password, passwordOptions)
    const userId = randomUUID()
    this.db.transaction(tx => {
      tx.insert(users).values({ id: userId, username, passwordHash, role: "user", status: "pending", createdAt: now, passwordChangedAt: now }).run()
      tx.update(invites).set({ usedAt: now, pendingUserId: userId }).where(eq(invites.id, invite.id)).run()
      tx.insert(auditEvents).values({ id: randomUUID(), userId, actorId: null, event: "account-requested", createdAt: now }).run()
    })
    return { pending: true }
  }

  listUsers() {
    return this.db.select({ id: users.id, username: users.username, role: users.role, status: users.status, createdAt: users.createdAt, approvedAt: users.approvedAt, totpEnabled: users.totpEnabled }).from(users).all()
  }

  listInvites() {
    return this.db.select({ id: invites.id, createdAt: invites.createdAt, expiresAt: invites.expiresAt, usedAt: invites.usedAt, pendingUserId: invites.pendingUserId }).from(invites).all()
  }

  approveUser(owner: AuthContext, userId: string) {
    const user = this.db.select().from(users).where(eq(users.id, userId)).get()
    if (!user || user.role === "owner") {
      throw new ApiFault(404, { code: "USER_NOT_FOUND", message: "The invited user does not exist.", action: "Refresh the user list." })
    }
    const now = Date.now()
    this.db.update(users).set({ status: "active", approvedAt: now, approvedBy: owner.user.id }).where(eq(users.id, user.id)).run()
    this.audit(user.id, owner.user.id, "account-approved")
  }

  rejectUser(owner: AuthContext, userId: string) {
    const user = this.db.select().from(users).where(and(eq(users.id, userId), eq(users.status, "pending"))).get()
    if (!user) {
      throw new ApiFault(404, { code: "PENDING_USER_NOT_FOUND", message: "The pending user does not exist.", action: "Refresh the user list." })
    }
    this.audit(user.id, owner.user.id, "account-rejected")
    this.db.delete(users).where(eq(users.id, user.id)).run()
  }

  setUserStatus(owner: AuthContext, userId: string, status: "active" | "disabled") {
    const user = this.db.select().from(users).where(eq(users.id, userId)).get()
    if (!user || user.role === "owner") {
      throw new ApiFault(404, { code: "USER_NOT_FOUND", message: "The invited user does not exist.", action: "Refresh the user list." })
    }
    this.db.update(users).set({ status }).where(eq(users.id, user.id)).run()
    this.destroyUserSessions(user.id)
    this.audit(user.id, owner.user.id, status === "active" ? "account-enabled" : "account-disabled")
  }

  removeUser(owner: AuthContext, userId: string) {
    const user = this.db.select().from(users).where(eq(users.id, userId)).get()
    if (!user || user.role === "owner") {
      throw new ApiFault(404, { code: "USER_NOT_FOUND", message: "The invited user does not exist.", action: "Refresh the user list." })
    }
    this.audit(user.id, owner.user.id, "account-removed")
    this.db.delete(users).where(eq(users.id, user.id)).run()
  }

  createPasswordReset(owner: AuthContext, userId: string) {
    const user = this.db.select().from(users).where(eq(users.id, userId)).get()
    if (!user || user.role === "owner") {
      throw new ApiFault(404, { code: "USER_NOT_FOUND", message: "The invited user does not exist.", action: "Refresh the user list." })
    }
    const code = randomToken(18)
    const expiresAt = Date.now() + 30 * 60 * 1000
    this.db.insert(passwordResets).values({ id: randomUUID(), userId, tokenHash: sha256(code), createdBy: owner.user.id, expiresAt, usedAt: null }).run()
    this.audit(userId, owner.user.id, "password-reset-created")
    return { code, expiresAt }
  }

  async completePasswordReset(code: string, password: string) {
    if (password.length < 12 || password.length > 128) {
      throw invalidRequest("The password must contain 12 to 128 characters.", "Choose a longer password.")
    }
    const reset = this.db.select().from(passwordResets).where(eq(passwordResets.tokenHash, sha256(code))).get()
    const now = Date.now()
    if (!reset || reset.expiresAt <= now || reset.usedAt) {
      throw new ApiFault(400, { code: "RESET_INVALID", message: "The reset code is invalid, expired, or already used.", action: "Ask the owner for a new reset code." })
    }
    const passwordHash = await argon2.hash(password, passwordOptions)
    this.db.transaction(tx => {
      tx.update(users).set({ passwordHash, passwordChangedAt: now, totpEnabled: false, totpSecret: null }).where(eq(users.id, reset.userId)).run()
      tx.update(passwordResets).set({ usedAt: now }).where(eq(passwordResets.id, reset.id)).run()
      tx.delete(sessions).where(eq(sessions.userId, reset.userId)).run()
      tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, reset.userId)).run()
    })
  }

  cleanup() {
    const now = Date.now()
    this.db.delete(sessions).where(or(lt(sessions.idleExpiresAt, now), lt(sessions.absoluteExpiresAt, now))).run()
    this.db.delete(loginChallenges).where(lt(loginChallenges.expiresAt, now)).run()
    this.db.delete(auditEvents).where(lt(auditEvents.createdAt, now - this.config.auditRetentionDays * 86400000)).run()
  }

  private audit(userId: string | null, actorId: string | null, event: string) {
    this.db.insert(auditEvents).values({ id: randomUUID(), userId, actorId, event, createdAt: Date.now() }).run()
  }
}
