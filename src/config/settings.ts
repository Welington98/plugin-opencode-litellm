import type { Auth } from "@opencode-ai/sdk/v2"
import { META_ENDPOINT, META_MODELS_CACHE, META_MODELS_FETCHED_AT, META_SCHEMA, METADATA_SCHEMA } from "../types"
import type { LiteLLMSettings, ModelsCache } from "../types"
import { parseEndpoint } from "../litellm/discovery"

export const META_LAST_ERROR = "last_error"
export const META_LAST_ERROR_AT = "last_error_at"

/** Extract normalized LiteLLM settings from the stored auth object. */
export function settingsFromAuth(auth: Auth | undefined): LiteLLMSettings | undefined {
  if (!auth) return undefined
  if (auth.type !== "api") return undefined
  const key = auth.key
  if (!key) return undefined

  const endpoint = parseEndpoint(auth.metadata?.[META_ENDPOINT])
  if (!endpoint) return undefined

  return { endpoint, apiKey: key }
}

/** Metadata written when a connection is saved. */
export function buildMetadata(input: {
  endpoint: string
  models: ModelsCache
}): Record<string, string> {
  return {
    [META_SCHEMA]: METADATA_SCHEMA,
    [META_ENDPOINT]: input.endpoint,
    [META_MODELS_FETCHED_AT]: String(input.models.fetchedAt),
    [META_MODELS_CACHE]: JSON.stringify(input.models.models),
  }
}

/** Merge a models cache into existing metadata (refresh path). */
export function mergeCacheMetadata(
  metadata: Record<string, string> | undefined,
  cache: ModelsCache,
): Record<string, string> {
  return {
    ...(metadata ?? {}),
    [META_MODELS_FETCHED_AT]: String(cache.fetchedAt),
    [META_MODELS_CACHE]: JSON.stringify(cache.models),
  }
}

export function readCache(metadata: Record<string, string> | undefined): ModelsCache | undefined {
  if (!metadata) return undefined
  if (metadata[META_SCHEMA] !== METADATA_SCHEMA) return undefined
  const fetchedAt = Number(metadata[META_MODELS_FETCHED_AT])
  const raw = metadata[META_MODELS_CACHE]
  if (!Number.isFinite(fetchedAt) || !raw) return undefined
  try {
    const models = JSON.parse(raw) as Record<string, unknown>
    if (!models || typeof models !== "object") return undefined
    return { fetchedAt, models: models as ModelsCache["models"] }
  } catch {
    return undefined
  }
}

export function readLastError(metadata: Record<string, string> | undefined): { message: string; at: number } | undefined {
  if (!metadata) return undefined
  const message = metadata[META_LAST_ERROR]
  const at = Number(metadata[META_LAST_ERROR_AT])
  if (!message) return undefined
  return { message, at: Number.isFinite(at) ? at : 0 }
}

export function clearLastError(metadata: Record<string, string> | undefined): Record<string, string> {
  const next = { ...(metadata ?? {}) }
  delete next[META_LAST_ERROR]
  delete next[META_LAST_ERROR_AT]
  return next
}
