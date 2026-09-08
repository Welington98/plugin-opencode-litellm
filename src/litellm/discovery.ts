import { CACHE_TTL_MS, META_MODELS_CACHE, META_MODELS_FETCHED_AT, META_ENDPOINT, META_SCHEMA, METADATA_SCHEMA } from "../types"
import type { DiscoveryResult, LiteLLMModel, LiteLLMModelGroup, LiteLLMSettings, ModelsCache } from "../types"
import { LiteLLMClient } from "./client"
import { buildModel, fromModelMeta, toModelMeta } from "../provider/models"
import { isChatModel } from "./capabilities"
import { validateEndpoint } from "../config/validation"

export { CACHE_TTL_MS }

/**
 * Discover the models an API key can access and their capabilities.
 *
 * Preference order:
 *   GET /v1/models                 -> authorized model ids
 *   GET /v1/model/info             -> capability + `blocked` metadata (primary)
 *   GET /model_group/info          -> fallback capability metadata (no `blocked`)
 *   (no metadata)                  -> conservative defaults
 *
 * Models reported as `blocked` (paused/disabled) are never exposed.
 */
export async function discoverModels(settings: LiteLLMSettings): Promise<DiscoveryResult> {
  const client = new LiteLLMClient(settings)

  const modelsResult = await client.fetchModels()
  if (!modelsResult.ok) {
    throw modelsResult.error
  }
  const ids = modelsResult.data.data.map((item) => item.id).filter((id): id is string => typeof id === "string" && id.length > 0)

  // Capability metadata is best-effort: failures degrade to conservative defaults.
  // We merge two sources because they expose different fields:
  //   - /v1/model/info     -> `blocked` (paused/disabled) + capabilities
  //   - /model_group/info  -> `providers` (placeholder detection) + capabilities
  const infoMap = new Map<string, LiteLLMModelGroup>()
  const infoResult = await client.fetchModelInfo()
  if (infoResult.ok) {
    for (const item of infoResult.data.data) {
      if (typeof item.model_name === "string" && item.model_name.length > 0) {
        infoMap.set(item.model_name, { ...(item.model_info ?? {}), model_group: item.model_name })
      }
    }
  }

  const groupMap = new Map<string, LiteLLMModelGroup>()
  const groupResult = await client.fetchModelGroupInfo()
  if (groupResult.ok) {
    for (const group of groupResult.data.data) {
      if (typeof group.model_group === "string" && group.model_group.length > 0) {
        groupMap.set(group.model_group, group)
      }
    }
  }

  // Merge: `/model_group/info` provides providers/capabilities, overlay the
  // `blocked` flag from `/v1/model/info`.
  const byId = new Map<string, LiteLLMModelGroup>()
  for (const [name, group] of groupMap) {
    byId.set(name, { ...group, blocked: infoMap.get(name)?.blocked })
  }
  for (const [name, info] of infoMap) {
    if (!byId.has(name)) byId.set(name, info)
  }

  const models: Record<string, LiteLLMModel> = {}
  for (const id of ids) {
    const meta = findMeta(id, byId)
    // Skip paused/disabled models (LiteLLM reports them via `blocked`).
    if (meta && meta.blocked === true) continue
    // Exclude non-chat models (embeddings, image gen, base completions, ...)
    // using the name heuristic (authoritative) plus `mode` metadata.
    if (!isChatModel(id, meta)) continue
    models[id] = buildModel(id, settings, meta)
  }

  if (Object.keys(models).length === 0) {
    const error = new Error("LiteLLM returned no usable chat models for this API key.")
    ;(error as Error & { kind?: string }).kind = "empty_list"
    throw error
  }

  return { models, fetchedAt: Date.now() }
}

/**
 * Resolve capability metadata for a model id from `/v1/models`. LiteLLM often
 * returns ids that do not exactly match the `model_group` key (provider
 * prefixes like `openai/gpt-4o`, or image size/quality variants like
 * `openai/1024-x-1024/dall-e-2`), so we fall back to progressively shorter
 * suffixes before giving up.
 */
export function findMeta(id: string, byId: Map<string, LiteLLMModelGroup>): LiteLLMModelGroup | undefined {
  if (byId.has(id)) return byId.get(id)
  const segments = id.split("/")
  for (let i = 1; i < segments.length; i++) {
    const candidate = segments.slice(i).join("/")
    if (candidate && byId.has(candidate)) return byId.get(candidate)
  }
  return undefined
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
