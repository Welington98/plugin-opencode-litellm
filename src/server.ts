import { Plugin, Model, Provider } from "@opencode/plugin"
import type { Model as LegacyModel } from "@opencode-ai/sdk/v2"
import { PROVIDER_ID } from "./types"
import {
  clearLastError,
  mergeCacheMetadata,
  readCache,
  readLastError,
  readFallbackMap,
  settingsFromAuth,
} from "./config/settings"
import { litellmBaseURL } from "./config/validation"
import { discoverModels, isCacheFresh, cacheToModels } from "./litellm/discovery"
import { readAuthRecord, removeAuthRecord, writeAuthRecord } from "./store/auth-file"
import { toModelMeta } from "./provider/models"
import { maskSecret, safeErrorMessage } from "./security/secrets"
import { pluginVersion } from "./config/version"

export type { LiteLLMModel, LiteLLMSettings } from "./types"

/**
 * OpenCode V2 server plugin.
 *
 * V1 used `export default { server: async () => ({ ...hooks }) }`. V2 loads a
 * definition directly and requires an id plus setup/effect. Keep all runtime
 * registrations in setup so the package can be loaded by OpenCode 2.x.
 */
export default Plugin.define({
  id: "welington98.opencode-litellm",
  async setup(ctx: Plugin.Context) {
    const auth = await readAuthRecord(PROVIDER_ID)
    const settings = settingsFromAuth(auth)
    let activeModels: Model.Info[] = []

    if (settings && auth) {
      const models = await loadModels(settings, auth)
      activeModels = models
      if (activeModels.length > 0) {
        await ctx.provider.transform((editor) => {
          const existing = editor.get(PROVIDER_ID)
          const providerID = Provider.ID.make(PROVIDER_ID)
          const info = {
            ...Provider.Info.empty(providerID),
            name: "LiteLLM",
            activation: "enabled" as const,
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: litellmBaseURL(settings.endpoint), apiKey: settings.apiKey },
          }
          if (existing) {
            editor.update(providerID, (provider) => Object.assign(provider, info))
            editor.models.set(providerID, activeModels)
          } else {
            editor.add({ info, models: activeModels })
          }
        })
      }
    }

    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "litellm", description: "LiteLLM management tools" })
      editor.add({
        name: "status",
        description: "Show LiteLLM connection status and discovered model count.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ content: await statusText() }),
      })
      editor.add({
        name: "refresh",
        description: "Refresh the LiteLLM model catalog.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ content: await refreshModels(ctx, (models) => { activeModels = models }) }),
      })
      editor.add({
        name: "disconnect",
        description: "Remove the stored LiteLLM credential and model cache.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          await removeAuthRecord(PROVIDER_ID)
          await ctx.provider.reload()
          return { content: "LiteLLM disconnected." }
        },
      })
    })
  },
}) satisfies Plugin.Plugin

async function loadModels(
  settings: { endpoint: string; apiKey: string },
  auth: NonNullable<Awaited<ReturnType<typeof readAuthRecord>>>,
) {
  const cache = readCache(auth.metadata)
  if (cache && isCacheFresh(cache)) return asV2Models(cacheToModels(cache))

  try {
    const result = await discoverModels(settings)
    await writeCache(settings.apiKey, auth, result)
    return asV2Models(result.models)
  } catch (error) {
    await writeError(settings.apiKey, auth, error)
    return cache ? asV2Models(cacheToModels(cache)) : []
  }
}

function asV2Models(models: Record<string, LegacyModel>) {
  return Object.values(models).map((model) => model as unknown as Model.Info)
}

async function refreshModels(ctx: Plugin.Context, setModels: (models: Model.Info[]) => void): Promise<string> {
  const auth = await readAuthRecord(PROVIDER_ID)
  const settings = settingsFromAuth(auth)
  if (!auth || !settings) return "LiteLLM is not configured. Run the setup flow first."
  try {
    const result = await discoverModels(settings)
    await writeCache(settings.apiKey, auth, result)
    setModels(asV2Models(result.models))
    await ctx.provider.reload()
    return `Refreshed LiteLLM models: ${Object.keys(result.models).length} discovered.`
  } catch (error) {
    return `LiteLLM refresh failed: ${safeErrorMessage(error, [settings.apiKey])}`
  }
}

async function writeCache(
  apiKey: string,
  auth: NonNullable<Awaited<ReturnType<typeof readAuthRecord>>>,
  result: { fetchedAt: number; models: Record<string, LegacyModel> },
) {
  const models: Record<string, ReturnType<typeof toModelMeta>> = {}
  for (const [id, model] of Object.entries(result.models)) models[id] = toModelMeta(model)
  await writeAuthRecord(PROVIDER_ID, {
    ...auth,
    key: apiKey,
    metadata: mergeCacheMetadata(clearLastError(auth.metadata), { fetchedAt: result.fetchedAt, models }),
  })
}

async function writeError(
  apiKey: string,
  auth: NonNullable<Awaited<ReturnType<typeof readAuthRecord>>>,
  error: unknown,
) {
  await writeAuthRecord(PROVIDER_ID, {
    ...auth,
    key: apiKey,
    metadata: {
      ...(auth.metadata ?? {}),
      last_error: safeErrorMessage(error, [apiKey]),
      last_error_at: String(Date.now()),
    },
  })
}

async function statusText(): Promise<string> {
  const auth = await readAuthRecord(PROVIDER_ID)
  const settings = settingsFromAuth(auth)
  if (!settings) return "LiteLLM: Not configured"
  const cache = auth ? readCache(auth.metadata) : undefined
  const lastError = auth ? readLastError(auth.metadata) : undefined
  const fallbacks = auth ? readFallbackMap(auth.metadata) : {}
  const lines = [
    "LiteLLM: Connected",
    `Version: ${pluginVersion()}`,
    `Endpoint: ${settings.endpoint}`,
    `API Key: ${maskSecret(settings.apiKey)}`,
    `Models: ${cache ? Object.keys(cache.models).length : 0}`,
  ]
  const configuredFallbacks = Object.entries(fallbacks).filter(([, target]) => target)
  if (configuredFallbacks.length) lines.push("Fallbacks:", ...configuredFallbacks.map(([kind, target]) => `  - ${kind}: ${target}`))
  if (lastError) lines.push(`Last error: ${lastError.message}`)
  return lines.join("\n")
}
