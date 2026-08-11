import type { ApiError } from "../shared/contracts"

export class ApiRequestError extends Error {
  constructor(readonly details: ApiError, readonly status: number) {
    super(details.message)
  }
}

export async function api<T>(path: string, options: RequestInit = {}, csrfToken?: string) {
  const headers = new Headers(options.headers)
  if (options.body && !(options.body instanceof FormData)) {
    headers.set("content-type", "application/json")
  }
  if (csrfToken) {
    headers.set("x-csrf-token", csrfToken)
  }
  const response = await fetch(path, { ...options, headers, credentials: "same-origin" })
  const contentType = response.headers.get("content-type") ?? ""
  const payload = contentType.includes("application/json") ? await response.json() : null
  if (!response.ok) {
    throw new ApiRequestError(payload ?? { code: "REQUEST_FAILED", message: "The request failed.", action: "Try again." }, response.status)
  }
  return payload as T
}

export function post<T>(path: string, body: unknown, csrfToken?: string) {
  return api<T>(path, { method: "POST", body: JSON.stringify(body) }, csrfToken)
}

export function formatError(error: unknown) {
  if (error instanceof ApiRequestError) {
    return `${error.details.message}${error.details.action ? ` ${error.details.action}` : ""}`
  }
  return error instanceof Error ? error.message : "The request failed. Try again."
}
