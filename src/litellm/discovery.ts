import { CACHE_TTL_MS, META_MODELS_CACHE, META_MODELS_FETCHED_AT, META_ENDPOINT, META_SCHEMA, METADATA_SCHEMA } from "../types"
import type { DiscoveryResult, LiteLLMModel, LiteLLMModelGroup, LiteLLMSettings, ModelsCache } from "../types"
import { LiteLLMClient } from "./client"
import { buildModel, fromModelMeta, toModelMeta } from "../provider/models"
import { isChatMode } from "./capabilities"
import { validateEndpoint } from "../config/validation"

export { CACHE_TTL_MS }

/**
 * Discover the models an API key can access and their capabilities.
 *
 * Preference order:
 *   GET /v1/models                 -> authorized model ids
 *   GET /model_group/info          -> richest capability metadata
 *   GET /v1/model/info             -> fallback capability metadata
 *   (no metadata)                  -> conservative defaults
 */
export async function discoverModels(settings: LiteLLMSettings): Promise<DiscoveryResult> {
  const client = new LiteLLMClient(settings)

  const modelsResult = await client.fetchModels()
  if (!modelsResult.ok) {
    throw modelsResult.error
  }
  const ids = modelsResult.data.data.map((item) => item.id).filter((id): id is string => typeof id === "string" && id.length > 0)

  // Capability metadata is best-effort: failures degrade to conservative defaults.
  let groups: LiteLLMModelGroup[] = []
  const groupResult = await client.fetchModelGroupInfo()
  if (groupResult.ok) {
    groups = groupResult.data.data
  } else {
    const infoResult = await client.fetchModelInfo()
    if (infoResult.ok) {
      groups = infoResult.data.data
        .filter((item) => typeof item.model_name === "string")
        .map((item) => ({
          ...(item.model_info ?? {}),
          model_group: item.model_name,
        }))
    }
  }

  const byId = new Map<string, LiteLLMModelGroup>()
  for (const group of groups) {
    if (typeof group.model_group === "string" && group.model_group.length > 0) {
      byId.set(group.model_group, group)
    }
  }

  const models: Record<string, LiteLLMModel> = {}
  for (const id of ids) {
    const meta = byId.get(id)
    // Exclude clearly non-chat model groups (embeddings, image gen, ...).
    if (meta && !isChatMode(meta.mode)) continue
    models[id] = buildModel(id, settings, meta)
  }

  if (Object.keys(models).length === 0) {
    const error = new Error("LiteLLM returned no usable chat models for this API key.")
    ;(error as Error & { kind?: string }).kind = "empty_list"
    throw error
  }

  return { models, fetchedAt: Date.now() }
}

/** Serialize a catalog into the string metadata fields. */
export function encodeCache(cache: ModelsCache): Record<string, string> {
  return {
    [META_SCHEMA]: METADATA_SCHEMA,
    [META_MODELS_FETCHED_AT]: String(cache.fetchedAt),
    [META_MODELS_CACHE]: JSON.stringify(cache.models),
  }
}

export function encodeEndpoint(endpoint: string): Record<string, string> {
  return { [META_ENDPOINT]: endpoint }
}

/** Parse metadata fields back into a cache envelope. Returns undefined on corruption. */
export function decodeCache(metadata: Record<string, string> | undefined): ModelsCache | undefined {
  if (!metadata) return undefined
  if (metadata[META_SCHEMA] !== METADATA_SCHEMA) return undefined

  const fetchedAtRaw = metadata[META_MODELS_FETCHED_AT]
  const raw = metadata[META_MODELS_CACHE]
  if (!fetchedAtRaw || !raw) return undefined

  const fetchedAt = Number(fetchedAtRaw)
  if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) return undefined

  try {
    const models = JSON.parse(raw) as Record<string, unknown>
    if (!models || typeof models !== "object") return undefined
    const entries = Object.entries(models)
    if (entries.length === 0) return undefined
    const restored: ModelsCache["models"] = {}
    for (const [id, value] of entries) {
      if (!value || typeof value !== "object") continue
      restored[id] = value as ModelsCache["models"][string]
    }
    if (Object.keys(restored).length === 0) return undefined
    return { fetchedAt, models: restored }
  } catch {
    return undefined
  }
}

/** Rehydrate cached ModelMeta into full opencode Models keyed by id. */
export function cacheToModels(cache: ModelsCache): Record<string, LiteLLMModel> {
  const out: Record<string, LiteLLMModel> = {}
  for (const [id, meta] of Object.entries(cache.models)) {
    out[id] = fromModelMeta(id, meta)
  }
  return out
}

export function isCacheFresh(cache: ModelsCache | undefined, now: number = Date.now()): boolean {
  if (!cache) return false
  return now - cache.fetchedAt <= CACHE_TTL_MS
}

/** Validate an endpoint string; returns normalized endpoint or undefined. */
export function parseEndpoint(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const result = validateEndpoint(raw)
  return result.ok ? result.value : undefined
}
