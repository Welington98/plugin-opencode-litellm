/**
 * Central secret-handling helpers.
 *
 * Rules enforced across the plugin:
 * - The LiteLLM API key is never logged, printed, or included in errors.
 * - Only `maskSecret()` output (e.g. `sk-****9fa2`) may be shown to the user.
 * - `redactError()` strips the raw key (and endpoint if requested) from any
 *   message before it is surfaced or logged.
 */

/** Mask a secret, keeping a short prefix and suffix. The result never grows. */
export function maskSecret(secret: string | undefined | null, opts: { keepPrefix?: number; keepSuffix?: number } = {}): string {
  if (!secret) return ""
  const { keepPrefix = Math.min(3, secret.length), keepSuffix = 4 } = opts
  if (secret.length <= keepPrefix + keepSuffix + 3) {
    const prefix = secret.slice(0, keepPrefix)
    return `${prefix}${"*".repeat(Math.max(1, secret.length - keepPrefix))}`
  }
  const prefix = secret.slice(0, keepPrefix)
  const suffix = secret.slice(-keepSuffix)
  return `${prefix}${"*".repeat(secret.length - keepPrefix - keepSuffix)}${suffix}`
}

/** True when the value looks like a LiteLLM/OpenAI API key (`sk-...`). */
export function looksLikeApiKey(value: string | undefined | null): boolean {
  return typeof value === "string" && /^sk-[A-Za-z0-9_.-]{4,}$/.test(value.trim())
}

/**
 * Remove occurrences of the raw secret (and optionally the endpoint) from an
 * error message so it is safe to log or display.
 */
export function redactError(
  message: string,
  secrets: Array<string | null | undefined>,
): string {
  let next = message
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue
    next = next.split(secret).join("[REDACTED]")
  }
  return next
}

/** Build a safe, human-readable message from a thrown error, redacting secrets. */
export function safeErrorMessage(
  error: unknown,
  secrets: Array<string | null | undefined>,
): string {
  const raw = error instanceof Error ? error.message : String(error)
  return redactError(raw, secrets)
}
