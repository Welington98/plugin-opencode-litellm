import { PROVIDER_ID } from "../types"
import type { LiteLLMModel, LiteLLMModelGroup, LiteLLMSettings, ModelMeta } from "../types"
import { litellmBaseURL } from "../config/validation"
import { buildCapabilities, buildCosts, buildLimits } from "../litellm/capabilities"

/**
 * Build the opencode Model objects that get registered under the `litellm`
 * provider. Requests are dispatched through `@ai-sdk/openai-compatible` with
 * `baseURL = <endpoint>/v1` (the base URL is supplied separately by the auth
 * `loader`, but `api.url` keeps a model consistent if options are missing).
 */
export function buildModel(modelID: string, settings: LiteLLMSettings, meta?: LiteLLMModelGroup): LiteLLMModel {
  const capabilities = buildCapabilities(meta)
  const limit = buildLimits(meta)
  const cost = buildCosts(meta)
  const name = displayName(modelID)

  return {
    id: modelID,
    providerID: PROVIDER_ID,
    name,
    family: PROVIDER_ID,
    api: {
      id: modelID,
      url: litellmBaseURL(settings.endpoint),
      npm: "@ai-sdk/openai-compatible",
    },
    status: "active",
    headers: {},
    options: {},
    cost,
    limit,
    capabilities,
    release_date: "",
    variants: {},
  }
}

/** Human-friendly display name for a LiteLLM model group id. */
export function displayName(modelID: string): string {
  const last = modelID.split("/").at(-1) ?? modelID
  return last.length > 0 ? last : modelID
}

/** Strip to the serializable cache form (no id/providerID). */
export function toModelMeta(model: LiteLLMModel): ModelMeta {
  const { id: _id, providerID: _providerID, ...rest } = model
  return rest
}

/** Rehydrate a full Model from a cached ModelMeta. */
export function fromModelMeta(modelID: string, meta: ModelMeta): LiteLLMModel {
  return {
    ...meta,
    id: modelID,
    providerID: PROVIDER_ID,
    capabilities: {
      ...meta.capabilities,
      input: { ...meta.capabilities.input },
      output: { ...meta.capabilities.output },
    },
    limit: { ...meta.limit },
    cost: {
      ...meta.cost,
      cache: { ...meta.cost.cache },
    },
    api: { ...meta.api },
  }
}
