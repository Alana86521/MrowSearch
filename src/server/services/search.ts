import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { SearchResponse } from "../../shared/contracts.js"
import { displayUrl } from "../../shared/url.js"
import type { AppConfig } from "../config.js"
import { ApiFault } from "../lib/errors.js"

const resultSchema = z.object({
  title: z.string().default("Untitled result"),
  url: z.string().url(),
  content: z.string().optional().default(""),
  engine: z.string().optional(),
  engines: z.array(z.string()).optional(),
  publishedDate: z.string().optional()
})

const responseSchema = z.object({
  results: z.array(z.unknown()).default([]),
  suggestions: z.array(z.string()).default([]),
  answers: z.array(z.unknown()).default([])
})

export class SearchService {
  constructor(private readonly config: AppConfig) {}

  async search(query: string, page: number, safeSearch: 0 | 1 | 2, signal?: AbortSignal): Promise<SearchResponse> {
    const body = new URLSearchParams({ q: query, format: "json", pageno: String(page), categories: "general", safesearch: String(safeSearch), language: "auto" })
    let response: Response
    try {
      response = await fetch(new URL("/search", this.config.searxngUrl), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body,
        signal
      })
    } catch {
      throw new ApiFault(503, { code: "SEARCH_UNAVAILABLE", message: "The search service did not respond.", action: "Try again. If the failure continues, ask the owner to check SearXNG." })
    }
    if (!response.ok) {
      throw new ApiFault(502, { code: "SEARCH_REJECTED", message: "The search service rejected the request.", action: "Try a different query or ask the owner to check the enabled engines." })
    }
    const parsed = responseSchema.safeParse(await response.json())
    if (!parsed.success) {
      throw new ApiFault(502, { code: "SEARCH_RESPONSE_INVALID", message: "The search service returned an invalid response.", action: "Ask the owner to check the SearXNG JSON format setting." })
    }
    const results = parsed.data.results.flatMap(value => {
      const result = resultSchema.safeParse(value)
      if (!result.success) {
        return []
      }
      const source = result.data.engine ?? result.data.engines?.join(", ") ?? "Search provider"
      return [{ id: randomUUID(), title: result.data.title, url: result.data.url, displayUrl: displayUrl(result.data.url), snippet: result.data.content, source, publishedAt: result.data.publishedDate }]
    }).slice(0, 20)
    if (results.length === 0) {
      throw new ApiFault(502, { code: "NO_SEARCH_RESULTS", message: "No enabled search engine returned a result.", action: "Try a different query or ask the owner to check the search engines." })
    }
    return {
      query,
      page,
      results,
      suggestions: parsed.data.suggestions.slice(0, 8),
      answers: parsed.data.answers.map(value => typeof value === "string" ? value : JSON.stringify(value)).slice(0, 3)
    }
  }
}
