import type { Model } from "@opencode-ai/sdk/v2"

export const PROVIDER_ID = "litellm"

/** How long a discovered model catalog is considered fresh before refetching. */
export const CACHE_TTL_MS = 5 * 60 * 1000

/** Default timeout for every LiteLLM HTTP call. */
export const REQUEST_TIMEOUT_MS = 10_000

/** Auth metadata schema version. Bump to invalidate old caches. */
export const METADATA_SCHEMA = "1"

export const META_ENDPOINT = "endpoint"
export const META_SCHEMA = "schema"
export const META_MODELS_CACHE = "models_cache"
export const META_MODELS_FETCHED_AT = "models_fetched_at"

/** Serializable slice of an opencode Model persisted in auth metadata as a cache. */
export type ModelMeta = Omit<Model, "id" | "providerID">

/** Normalized settings extracted from stored credentials. */
export type LiteLLMSettings = {
  endpoint: string
  apiKey: string
}

/** A model group descriptor returned by LiteLLM metadata endpoints. */
export type LiteLLMModelGroup = {
  model_group: string
  providers?: string[]
  mode?: string
  supports_vision?: boolean
  supports_function_calling?: boolean
  supports_parallel_function_calling?: boolean
  supports_temperature?: boolean
  supports_reasoning?: boolean
  supports_prompt_caching?: boolean
  supports_audio_input?: boolean
  supports_audio_output?: boolean
  supports_pdf_input?: boolean
  supports_computer_use?: boolean
  max_input_tokens?: number
  max_output_tokens?: number
  max_tokens?: number
  input_cost_per_token?: number
  output_cost_per_token?: number
  cache_read_input_token_cost?: number
  cache_write_input_token_cost?: number
}

/** Item from `GET /v1/model/info`. */
export type LiteLLMModelInfoItem = {
  model_name: string
  model_info?: Partial<LiteLLMModelGroup>
}

/** Item from `GET /v1/models`. */
export type LiteLLMModelsItem = {
  id: string
  object?: string
  created?: number
  owned_by?: string
}

/** The opencode Model object we return to opencode for a discovered LiteLLM model. */
export type LiteLLMModel = Model

export type DiscoveryResult = {
  models: Record<string, LiteLLMModel>
  fetchedAt: number
}

/** Cache envelope stored in auth metadata. */
export type ModelsCache = {
  fetchedAt: number
  models: Record<string, ModelMeta>
}
