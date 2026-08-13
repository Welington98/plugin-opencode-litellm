import type { ProviderConfig } from "@opencode-ai/sdk"
import type { Model } from "@opencode-ai/sdk/v2"
import { litellmBaseURL } from "../config/validation"

export const PROVIDER_NAME = "LiteLLM"

/**
 * Build the `opencode.json`-style provider config that the plugin injects via
 * the `config` hook. Because `litellm` is not part of opencode's built-in
 * models catalog, this is the official way for a plugin to register a fully
 * dynamic provider: opencode runs the `config` hook before it reads
 * `cfg.provider`, so the injected entry becomes part of the provider catalog.
 *
 * The generated SDK `ProviderConfig` type is a subset of what opencode's
 * runtime accepts (which additionally supports `family`, `interleaved`,
 * `provider.api`, `variants`, `limit.input`); we emit the richer runtime shape.
 */
export function buildProviderConfig(models: Record<string, Model>): ProviderConfig {
  const configModels: NonNullable<ProviderConfig["models"]> = {}
  for (const [id, model] of Object.entries(models)) {
    configModels[id] = modelToConfigModel(model) as NonNullable<ProviderConfig["models"]>[string]
  }
  return {
    name: PROVIDER_NAME,
    env: [],
    options: {},
    models: configModels,
  }
}

type RuntimeConfigModel = NonNullable<ProviderConfig["models"]>[string] & {
  family?: string
  interleaved?: boolean | string | { field: string }
  provider?: { npm?: string; api?: string }
  variants?: Record<string, unknown>
  limit?: { context: number; input?: number; output: number }
}

function modelToConfigModel(model: Model): RuntimeConfigModel {
  return {
    id: model.id,
    name: model.name,
    family: model.family,
    release_date: model.release_date,
    attachment: model.capabilities.attachment,
    reasoning: model.capabilities.reasoning,
    temperature: model.capabilities.temperature,
    tool_call: model.capabilities.toolcall,
    interleaved: model.capabilities.interleaved,
    cost: {
      input: model.cost.input,
      output: model.cost.output,
      cache_read: model.cost.cache.read,
      cache_write: model.cost.cache.write,
    },
    limit: {
      context: model.limit.context,
      input: model.limit.input,
      output: model.limit.output,
    },
    modalities: {
      input: modalityList(model.capabilities.input),
      output: modalityList(model.capabilities.output),
    },
    status: model.status,
    provider: {
      npm: model.api.npm,
      api: model.api.url,
    },
    options: model.options,
    headers: model.headers,
    variants: model.variants,
  }
}

function modalityList(modalities: Model["capabilities"]["input"]): Array<"text" | "audio" | "image" | "video" | "pdf"> {
  return (Object.keys(modalities) as Array<keyof typeof modalities>).filter((key) => modalities[key])
}

/** Base URL used by the auth loader so requests hit <endpoint>/v1. */
export function loaderBaseURL(endpoint: string): string {
  return litellmBaseURL(endpoint)
}
