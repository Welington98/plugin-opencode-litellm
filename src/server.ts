import { type Hooks, type Plugin, type PluginInput, type PluginOptions, type Config, tool } from "@opencode-ai/plugin"
import type { ApiAuth, Model } from "@opencode-ai/sdk/v2"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { PROVIDER_ID } from "./types"
import {
  clearLastError,
  mergeCacheMetadata,
  readCache,
  readLastError,
  settingsFromAuth,
} from "./config/settings"
import { litellmBaseURL, validateEndpoint } from "./config/validation"
import { LiteLLMClient } from "./litellm/client"
import { cacheToModels, discoverModels, isCacheFresh } from "./litellm/discovery"
import { readAuthRecord, removeAuthRecord } from "./store/auth-file"
import { buildProviderConfig } from "./provider/config-provider"
import { toModelMeta } from "./provider/models"
import { maskSecret, safeErrorMessage } from "./security/secrets"

export type { LiteLLMModel, LiteLLMSettings } from "./types"

/**
 * Server-side entrypoint for the opencode-litellm plugin.
 *
 * - `config`  : registers the dynamic `litellm` provider by injecting it into
 *               the merged config before opencode builds the provider catalog.
 * - `auth`    : exposes LiteLLM in `/connect` + `opencode auth login`, and
 *               injects `{ apiKey, baseURL }` into the OpenAI-compatible SDK.
 * - `tool`    : `litellm_status` / `litellm_refresh` / `litellm_disconnect` /
 *               `litellm_test` callable from any chat session.
 */
export const LiteLLMPlugin: Plugin = async (input: PluginInput, _options?: PluginOptions): Promise<Hooks> => {
  const client = input.client

  return {
    config: async (cfg) => {
      await injectLiteLLMProvider(cfg, client)
    },

    auth: {
      provider: PROVIDER_ID,
      loader: async (getAuth) => {
        const settings = settingsFromAuth(await getAuth())
        if (!settings) return {}
        return {
          apiKey: settings.apiKey,
          baseURL: litellmBaseURL(settings.endpoint),
        }
      },
      methods: [
        {
          type: "api",
          label: "LiteLLM API key",
          prompts: [
            {
              type: "text",
              key: "endpoint",
              message: "LiteLLM Endpoint",
              placeholder: "https://litellm.example.com",
              validate: (value) => {
                const result = validateEndpoint(value ?? "")
                return result.ok ? undefined : result.message
              },
            },
          ],
        },
      ],
    },

    tool: {
      litellm_status: tool({
        description:
          "Show the LiteLLM connection status: endpoint, masked API key, number of discovered models, last refresh time and last error.",
        args: {},
        async execute() {
          return await awaitStatusText()
        },
      }),

      litellm_test: tool({
        description:
          "Test the configured LiteLLM connection: endpoint reachability, TLS, authentication and model discovery.",
        args: {},
        async execute() {
          const auth = await readAuthRecord(PROVIDER_ID)
          const settings = auth ? settingsFromAuth(auth) : undefined
          if (!settings) return "LiteLLM is not configured. Run /litellm setup or `opencode auth login litellm` first."
          const conn = new LiteLLMClient(settings)
          const result = await conn.testConnection()
          if (result.ok) {
            return `✓ LiteLLM connected. Authentication successful. ${result.count} models accessible.`
          }
          return `LiteLLM connection failed: ${result.error.message}`
        },
      }),

      litellm_refresh: tool({
        description:
          "Refresh the LiteLLM model catalog from the proxy: re-discovers the models the configured API key can access and their capabilities.",
        args: {},
        async execute() {
          const auth = await readAuthRecord(PROVIDER_ID)
          const settings = auth ? settingsFromAuth(auth) : undefined
          if (!settings || !auth) {
            return "LiteLLM is not configured. Run /litellm setup or `opencode auth login litellm` first."
          }
          try {
            const result = await discoverModels(settings)
            await persistCache(client, settings, auth, result)
            return `✓ Refreshed LiteLLM models: ${Object.keys(result.models).length} models discovered. Restart opencode (or run /litellm refresh in the TUI) for the picker to update.`
          } catch (error) {
            return `Failed to refresh LiteLLM models: ${safeErrorMessage(error, [settings.apiKey])}`
          }
        },
      }),

      litellm_disconnect: tool({
        description: "Remove the stored LiteLLM credential and all discovered models.",
        args: {},
        async execute() {
          await removeAuthRecord(PROVIDER_ID)
          return "✓ Disconnected LiteLLM. The credential and discovered models were removed. Restart opencode to fully clear the provider."
        },
      }),
    },

    dispose: async () => {},
  }
}

export default LiteLLMPlugin

/** Inject the `litellm` provider into the merged config (official plugin mechanism). */
async function injectLiteLLMProvider(cfg: Config, client: OpencodeClient): Promise<void> {
  const auth = await readAuthRecord(PROVIDER_ID)
  if (!auth) return
  const settings = settingsFromAuth(auth)
  if (!settings) return

  const cache = readCache(auth.metadata)
  let models: Record<string, Model> | undefined

  if (cache && isCacheFresh(cache)) {
    models = cacheToModels(cache)
  } else if (cache) {
    // Serve stale models now; refresh in the background so startup is never blocked.
    models = cacheToModels(cache)
    void refreshInBackground(client, settings, auth)
  } else {
    // First connect / endpoint change: block once so models appear immediately.
    try {
      const result = await discoverModels(settings)
      models = result.models
      await persistCache(client, settings, auth, result)
    } catch (error) {
      await persistError(client, settings, auth, error)
      return
    }
  }

  if (models && Object.keys(models).length > 0) {
    if (!cfg.provider) cfg.provider = {}
    cfg.provider[PROVIDER_ID] = buildProviderConfig(models)
  }
}

async function refreshInBackground(
  client: OpencodeClient,
  settings: { endpoint: string; apiKey: string },
  auth: ApiAuth,
): Promise<void> {
  try {
    const result = await discoverModels(settings)
    await persistCache(client, settings, auth, result)
  } catch (error) {
    await persistError(client, settings, auth, error).catch(() => {})
  }
}

async function persistCache(
  client: OpencodeClient,
  settings: { endpoint: string; apiKey: string },
  auth: ApiAuth,
  result: { fetchedAt: number; models: Record<string, Model> },
): Promise<void> {
  const models: Record<string, ReturnType<typeof toModelMeta>> = {}
  for (const [id, model] of Object.entries(result.models)) {
    models[id] = toModelMeta(model)
  }
  const metadata = mergeCacheMetadata(clearLastError(auth.metadata), { fetchedAt: result.fetchedAt, models })
  await client.auth.set({
    path: { id: PROVIDER_ID },
    body: { type: "api", key: settings.apiKey, metadata },
  })
}

async function persistError(
  client: OpencodeClient,
  settings: { endpoint: string; apiKey: string },
  auth: ApiAuth,
  error: unknown,
): Promise<void> {
  const message = safeErrorMessage(error, [settings.apiKey])
  const metadata = {
    ...(auth.metadata ?? {}),
    last_error: message,
    last_error_at: String(Date.now()),
  }
  await client.auth.set({
    path: { id: PROVIDER_ID },
    body: { type: "api", key: settings.apiKey, metadata },
  })
}

async function awaitStatusText(): Promise<string> {
  const auth = await readAuthRecord(PROVIDER_ID)
  if (!auth) return "LiteLLM: Not configured\nRun /litellm setup or `opencode auth login litellm` to connect."
  const settings = settingsFromAuth(auth)
  if (!settings) return "LiteLLM: Not configured (missing endpoint). Run /litellm setup again."
  const cache = readCache(auth.metadata)
  const lastError = readLastError(auth.metadata)
  const count = cache ? Object.keys(cache.models).length : 0
  const lastRefresh = cache ? formatRelativeTime(cache.fetchedAt) : "never"
  const lines = [
    "LiteLLM: Connected",
    `Endpoint: ${settings.endpoint}`,
    `API Key: ${maskSecret(settings.apiKey)}`,
    `Models: ${count}`,
    `Last refresh: ${lastRefresh}`,
  ]
  if (lastError) lines.push(`Last error: ${lastError.message}`)
  return lines.join("\n")
}

function formatRelativeTime(ms: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
