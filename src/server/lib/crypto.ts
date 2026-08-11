import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url")
}

export function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("base64url")
}

export function hmac(value: string | Buffer, key: Buffer) {
  return createHmac("sha256", key).update(value).digest("base64url")
}

export function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  if (leftBuffer.length !== rightBuffer.length) {
    return false
  }
  return timingSafeEqual(leftBuffer, rightBuffer)
}

export function encryptText(value: string, key: Buffer, aad: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(Buffer.from(aad, "utf8"))
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv, tag, ciphertext].map(part => part.toString("base64url")).join(".")
}

export function decryptText(value: string, key: Buffer, aad: string) {
  const parts = value.split(".")
  if (parts.length !== 3) {
    throw new Error("Encrypted data has an invalid format.")
  }
  const [ivValue, tagValue, ciphertextValue] = parts
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64url"))
  decipher.setAAD(Buffer.from(aad, "utf8"))
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"))
  return Buffer.concat([decipher.update(Buffer.from(ciphertextValue, "base64url")), decipher.final()]).toString("utf8")
}
