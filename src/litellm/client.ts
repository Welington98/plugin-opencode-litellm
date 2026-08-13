import { REQUEST_TIMEOUT_MS } from "../types"
import type { LiteLLMModelsItem, LiteLLMModelGroup, LiteLLMModelInfoItem, LiteLLMSettings } from "../types"
import { redactError } from "../security/secrets"

/**
 * Classified connection failures. `kind` drives user-facing messages; the raw
 * message is redacted so the API key never leaks.
 */
export type LiteLLMErrorKind =
  | "invalid_endpoint"
  | "invalid_protocol"
  | "dns"
  | "tls"
  | "timeout"
  | "connection_refused"
  | "network"
  | "auth_failed"
  | "not_found"
  | "rate_limited"
  | "server_error"
  | "invalid_response"
  | "empty_list"
  | "revoked_key"

export class LiteLLMError extends Error {
  readonly kind: LiteLLMErrorKind
  readonly status?: number

  constructor(kind: LiteLLMErrorKind, message: string, status?: number) {
    super(message)
    this.name = "LiteLLMError"
    this.kind = kind
    this.status = status
  }
}

export type FetchResult<T> = { ok: true; data: T } | { ok: false; error: LiteLLMError }

export class LiteLLMClient {
  constructor(
    private readonly settings: LiteLLMSettings,
    private readonly options: { timeoutMs?: number; userAgent?: string } = {},
  ) {}

  private get endpoint(): string {
    return this.settings.endpoint
  }

  private get apiKey(): string {
    return this.settings.apiKey
  }

  private safeMessage(raw: string): string {
    return redactError(raw, [this.apiKey])
  }

  private async request<T>(path: string, timeoutMs?: number): Promise<FetchResult<T>> {
    const effectiveTimeout = timeoutMs ?? this.options.timeoutMs ?? REQUEST_TIMEOUT_MS
    let url: URL
    try {
      url = new URL(path, this.endpoint)
    } catch {
      return { ok: false, error: new LiteLLMError("invalid_endpoint", "Endpoint is not a valid URL") }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error("LiteLLM request timed out")), effectiveTimeout)

    let response: Response
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          "User-Agent": this.options.userAgent ?? "opencode-litellm",
        },
        signal: controller.signal,
      })
    } catch (error) {
      return { ok: false, error: this.classifyNetworkError(error) }
    } finally {
      clearTimeout(timer)
    }

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        error: new LiteLLMError(
          "auth_failed",
          response.status === 401 ? "Authentication failed. Check your LiteLLM API key." : "Access denied (403). This key cannot list models.",
          response.status,
        ),
      }
    }
    if (response.status === 404) {
      return {
        ok: false,
        error: new LiteLLMError(
          "not_found",
          "Model list endpoint not found (404). Verify the endpoint points to the LiteLLM proxy root.",
          response.status,
        ),
      }
    }
    if (response.status === 429) {
      return {
        ok: false,
        error: new LiteLLMError("rate_limited", "LiteLLM rate limit exceeded (429). Try again shortly.", response.status),
      }
    }
    if (response.status >= 500) {
      return {
        ok: false,
        error: new LiteLLMError(
          "server_error",
          `LiteLLM proxy returned ${response.status}. The proxy may be offline or misconfigured.`,
          response.status,
        ),
      }
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "")
      return {
        ok: false,
        error: new LiteLLMError(
          "network",
          this.safeMessage(`LiteLLM proxy returned ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`),
          response.status,
        ),
      }
    }

    let json: unknown
    try {
      json = await response.json()
    } catch {
      return { ok: false, error: new LiteLLMError("invalid_response", "LiteLLM returned a non-JSON response.") }
    }
    return { ok: true, data: json as T }
  }

  private classifyNetworkError(error: unknown): LiteLLMError {
    const message = this.safeMessage(error instanceof Error ? error.message : String(error))
    const lower = message.toLowerCase()
    const code = typeof (error as { code?: unknown })?.code === "string" ? String((error as { code?: unknown }).code) : ""
    const upperCode = code.toUpperCase()
    const causeCode =
      error instanceof Error && error.cause instanceof Error && typeof (error.cause as { code?: unknown }).code === "string"
        ? String((error.cause as { code?: unknown }).code).toUpperCase()
        : ""
    const causeMsg = error instanceof Error && error.cause instanceof Error ? error.cause.message.toLowerCase() : ""

    const source = `${lower} ${causeMsg}`
    const codes = `${upperCode} ${causeCode}`

    if (error instanceof Error && (error.name === "AbortError" || upperCode === "ABORT_ERR")) {
      return new LiteLLMError("timeout", `Request to LiteLLM timed out after ${this.options.timeoutMs ?? REQUEST_TIMEOUT_MS}ms.`)
    }
    if (codes.includes("ETIMEDOUT") || codes.includes("UND_ERR_CONNECT_TIMEOUT")) {
      return new LiteLLMError("timeout", `Request to LiteLLM timed out after ${this.options.timeoutMs ?? REQUEST_TIMEOUT_MS}ms.`)
    }
    if (codes.includes("ENOTFOUND") || codes.includes("EAI_AGAIN") || codes.includes("DNS")) {
      return new LiteLLMError("dns", "Could not resolve the LiteLLM endpoint host (DNS error).")
    }
    if (
      codes.includes("ECONNREFUSED") ||
      codes.includes("CONNECTIONREFUSED") ||
      source.includes("connection refused") ||
      source.includes("unable to connect") ||
      source.includes("could not connect")
    ) {
      return new LiteLLMError("connection_refused", "Connection refused. Is the LiteLLM proxy running and reachable?")
    }
    if (
      codes.includes("CERT") ||
      codes.includes("SSL") ||
      codes.includes("TLS") ||
      source.includes("tls") ||
      source.includes("certificate") ||
      source.includes("self-signed")
    ) {
      return new LiteLLMError("tls", "TLS error connecting to the endpoint. Check the certificate.")
    }
    if (source.includes("timed out") || source.includes("timeout")) {
      return new LiteLLMError("timeout", `Request to LiteLLM timed out after ${this.options.timeoutMs ?? REQUEST_TIMEOUT_MS}ms.`)
    }
    if (source.includes("invalid url") || source.includes("protocol")) {
      return new LiteLLMError("invalid_protocol", "Invalid endpoint URL.")
    }
    return new LiteLLMError("network", this.safeMessage(`Network error reaching LiteLLM: ${message}`))
  }

  /** GET <endpoint>/v1/models — the key-filtered list of authorized models. */
  async fetchModels(timeoutMs?: number): Promise<FetchResult<{ data: LiteLLMModelsItem[] }>> {
    const result = await this.request<{ data?: LiteLLMModelsItem[] }>("/v1/models", timeoutMs)
    if (!result.ok) return result

    if (!Array.isArray(result.data.data)) {
      return { ok: false, error: new LiteLLMError("invalid_response", "LiteLLM /v1/models returned an unexpected shape.") }
    }
    if (result.data.data.length === 0) {
      return { ok: false, error: new LiteLLMError("empty_list", "LiteLLM returned no models for this API key.") }
    }
    return { ok: true, data: result.data as { data: LiteLLMModelsItem[] } }
  }

  /** GET <endpoint>/model_group/info — richest capability metadata. Best-effort. */
  async fetchModelGroupInfo(timeoutMs?: number): Promise<FetchResult<{ data: LiteLLMModelGroup[] }>> {
    const result = await this.request<{ data?: LiteLLMModelGroup[] }>("/model_group/info", timeoutMs)
    if (!result.ok) return result
    if (!Array.isArray(result.data.data)) {
      return { ok: false, error: new LiteLLMError("invalid_response", "LiteLLM /model_group/info returned an unexpected shape.") }
    }
    return { ok: true, data: result.data as { data: LiteLLMModelGroup[] } }
  }

  /** GET <endpoint>/v1/model/info — fallback capability metadata. Best-effort. */
  async fetchModelInfo(timeoutMs?: number): Promise<FetchResult<{ data: LiteLLMModelInfoItem[] }>> {
    const result = await this.request<{ data?: LiteLLMModelInfoItem[] }>("/v1/model/info", timeoutMs)
    if (!result.ok) return result
    if (!Array.isArray(result.data.data)) {
      return { ok: false, error: new LiteLLMError("invalid_response", "LiteLLM /v1/model/info returned an unexpected shape.") }
    }
    return { ok: true, data: result.data as { data: LiteLLMModelInfoItem[] } }
  }

  /**
   * Test a connection end-to-end:
   * 1. endpoint reachable (any fetch failure maps to a readable error)
   * 2. TLS/HTTP valid
   * 3. authentication (`/v1/models` 401/403 handled)
   * 4. valid response shape
   * 5. non-empty authorized model list
   */
  async testConnection(): Promise<{ ok: true; count: number } | { ok: false; error: LiteLLMError }> {
    const models = await this.fetchModels()
    if (!models.ok) return { ok: false, error: models.error }
    const count = models.data.data.length
    if (count === 0) {
      return { ok: false, error: new LiteLLMError("empty_list", "LiteLLM returned no models for this API key.") }
    }
    return { ok: true, count }
  }
}
