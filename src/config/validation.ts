/** Validation helpers for user-provided LiteLLM settings. */

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string }

/** Normalize a user-supplied endpoint into a clean base URL (no trailing slash). */
export function normalizeEndpoint(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "")
  return trimmed
}

export function validateEndpoint(input: string): ValidationResult<string> {
  const raw = (input ?? "").trim()
  if (!raw) {
    return { ok: false, message: "Endpoint is required" }
  }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, message: "Endpoint is not a valid URL" }
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, message: "Endpoint must use http:// or https://" }
  }

  if (!url.hostname) {
    return { ok: false, message: "Endpoint is missing a host" }
  }

  return { ok: true, value: normalizeEndpoint(raw) }
}

export function validateApiKey(input: string): ValidationResult<string> {
  const key = (input ?? "").trim()
  if (!key) {
    return { ok: false, message: "API key is required" }
  }
  if (key.length < 8) {
    return { ok: false, message: "API key is too short" }
  }
  return { ok: true, value: key }
}

/** The OpenAI-compatible base path under a LiteLLM endpoint. */
export function litellmBaseURL(endpoint: string): string {
  return `${normalizeEndpoint(endpoint)}/v1`
}
