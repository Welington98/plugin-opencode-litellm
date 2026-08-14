import type { Auth } from "@opencode-ai/sdk/v2"
import { META_ENDPOINT, META_MODELS_CACHE, META_MODELS_FETCHED_AT, META_SCHEMA, METADATA_SCHEMA, META_FALLBACKS, type Modality } from "../types"
import type { LiteLLMSettings, ModelsCache } from "../types"
import { parseEndpoint } from "../litellm/discovery"
import { configFilePath } from "../store/auth-file"

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
    [META_SCHEMA]: METADATA_SCHEMA,
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

export function readFallbackMap(metadata: Record<string, string> | undefined): Record<Modality, string> {
  const map: Record<Modality, string> = { image: "", pdf: "", audio: "" }
  if (!metadata) return map
  const raw = metadata[META_FALLBACKS]
  if (!raw) return map
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (parsed && typeof parsed === "object") {
      for (const key of ["image", "pdf", "audio"] as const) {
        if (typeof parsed[key] === "string") {
          map[key] = parsed[key]
        }
      }
    }
  } catch {
    // ignore parsing errors
  }
  return map
}

export function writeFallbackMap(
  metadata: Record<string, string> | undefined,
  map: Record<Modality, string>,
): Record<string, string> {
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries(map)) {
    if (v) clean[k] = v
  }
  return {
    ...(metadata ?? {}),
    [META_FALLBACKS]: JSON.stringify(clean),
  }
}

export async function registerAgentConfig(name: string, model: string, prompt: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const filePath = configFilePath()
    const file = Bun.file(filePath)
    let config: Record<string, any> = {}
    if (await file.exists()) {
      try {
        config = await file.json() as Record<string, any>
      } catch {
        // invalid JSON
      }
    }
    if (!config || typeof config !== "object") config = {}
    config.agent = config.agent || {}
    config.agent[name] = {
      model,
      prompt,
      mode: "subagent",
      hidden: true,
      description: `Custom vision/media fallback subagent created dynamically for litellm.`,
    }
    await Bun.write(filePath, JSON.stringify(config, null, 2))
    return { ok: true }
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) }
  }
}
