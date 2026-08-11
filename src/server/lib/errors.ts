import type { FastifyReply } from "fastify"
import type { ApiError } from "../../shared/contracts.js"

export class ApiFault extends Error {
  readonly statusCode: number
  readonly body: ApiError

  constructor(statusCode: number, body: ApiError) {
    super(body.message)
    this.statusCode = statusCode
    this.body = body
  }
}

export function sendFault(reply: FastifyReply, fault: ApiFault) {
  return reply.status(fault.statusCode).send(fault.body)
}

export function invalidRequest(message: string, action?: string, fieldErrors?: Record<string, string>) {
  return new ApiFault(400, { code: "INVALID_REQUEST", message, action, fieldErrors })
}

export function notAuthenticated() {
  return new ApiFault(401, { code: "NOT_AUTHENTICATED", message: "Your session is not active.", action: "Sign in and try again." })
}

export function notAuthorized() {
  return new ApiFault(403, { code: "NOT_AUTHORIZED", message: "Your account cannot use this action.", action: "Ask the owner if you need access." })
}
