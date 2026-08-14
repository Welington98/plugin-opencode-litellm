import { type Hooks, type Plugin, type PluginModule, type PluginInput, type PluginOptions, type Config, tool } from "@opencode-ai/plugin"
import type { ApiAuth, Model } from "@opencode-ai/sdk/v2"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { PROVIDER_ID, META_FALLBACKS, type Modality } from "./types"
import {
  clearLastError,
  mergeCacheMetadata,
  readCache,
  readLastError,
  settingsFromAuth,
  readFallbackMap,
  writeFallbackMap,
  registerAgentConfig,
} from "./config/settings"
import { z } from "zod"
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
      
      // Register static hidden subagent for standard fallbacks
      cfg.agent = cfg.agent || {}
      cfg.agent["litellm-media"] = {
        prompt: "You are a media analyzer subagent. Analyze the attached file(s) and provide a detailed textual description, transcription, or summary as appropriate. Return ONLY the description, transcription, or summary, with no introduction or preamble.",
        mode: "subagent",
        hidden: true,
        description: "Standard media fallback subagent for the LiteLLM plugin.",
      }
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

      litellm_register_agent: tool({
        description: "Register a custom fallback subagent in the global opencode.json config file.",
        args: {
          name: z.string().describe("The agent name in kebab-case"),
          model: z.string().describe("The model ID (e.g. litellm/gemini-3.5-flash)"),
          prompt: z.string().describe("The system prompt for the agent"),
        },
        async execute(args) {
          const result = await registerAgentConfig(args.name, args.model, args.prompt)
          if (result.ok) {
            return `✓ Agent "${args.name}" successfully registered in global opencode.json config.`
          }
          return `Failed to register agent: ${result.error}`
        },
      }),

      litellm_set_fallback: tool({
        description: "Configure a fallback model or agent for a specific media modality (image, pdf, audio).",
        args: {
          modality: z.enum(["image", "pdf", "audio"]).describe("The media modality"),
          target: z.string().describe("The target model ID or 'agent:<name>', or empty to clear"),
        },
        async execute(args) {
          const auth = await readAuthRecord(PROVIDER_ID)
          if (!auth) return "LiteLLM is not configured."
          const currentMap = readFallbackMap(auth.metadata)
          currentMap[args.modality] = args.target
          const metadata = writeFallbackMap(auth.metadata, currentMap)
          
          const result = await client.auth.set({
            path: { id: PROVIDER_ID },
            body: { type: "api", key: auth.key, metadata },
          })
          if (result.error) {
            return `Failed to configure fallback: ${safeErrorMessage(result.error, [auth.key])}`
          }
          return `✓ Fallback for "${args.modality}" set to "${args.target || "none (cleared)"}".`
        },
      }),
    },

    "chat.message": async (input, output) => {
      const msgModel = output.message.model
      if (!msgModel || msgModel.providerID !== PROVIDER_ID) return

      const parts = output.parts
      const hasImage = parts.some((p) => p.type === "file" && p.mime?.startsWith("image/"))
      const hasPdf = parts.some((p) => p.type === "file" && p.mime === "application/pdf")
      const hasAudio = parts.some((p) => p.type === "file" && p.mime?.startsWith("audio/"))

      if (!hasImage && !hasPdf && !hasAudio) return

      const auth = await readAuthRecord(PROVIDER_ID)
      if (!auth) return
      const cache = readCache(auth.metadata)
      if (!cache) return

      const fallbackMap = readFallbackMap(auth.metadata)
      const currentModelMeta = cache.models[msgModel.modelID]

      const runFallbackSubagent = async (target: string, modalityParts: typeof parts, defaultPrompt: string): Promise<string> => {
        const isAgent = target.startsWith("agent:")
        const targetAgent = isAgent ? target.slice(6) : "litellm-media"
        const targetModel = isAgent ? undefined : { providerID: PROVIDER_ID, modelID: target }

        const childRes = await client.session.create({
          body: {
            parentID: input.sessionID,
            title: `Media analysis (@${targetAgent})`,
          },
        })
        if (childRes.error) {
          throw new Error(safeErrorMessage(childRes.error, [auth.key]))
        }
        if (!childRes.data) {
          throw new Error("Failed to create child session: response empty")
        }
        const childID = childRes.data.id

        const res = await client.session.prompt({
          path: { id: childID },
          body: {
            agent: targetAgent,
            ...(targetModel && { model: targetModel }),
            parts: modalityParts.map((p) => ({
              type: "file" as const,
              mime: (p as any).mime,
              filename: (p as any).filename,
              url: (p as any).url,
            })),
          },
        })
        if (res.error) {
          throw new Error(safeErrorMessage(res.error, [auth.key]))
        }
        if (!res.data) {
          throw new Error("Failed to run prompt on child session: response empty")
        }

        const textParts = res.data.parts.filter((p: any) => p.type === "text")
        const text = textParts.map((p: any) => p.text).join("\n").trim()
        return text || "(sem descrição)"
      }

      const modalitiesToProcess: Array<{ modality: Modality; partsFilter: (p: any) => boolean; defaultPrompt: string }> = []
      if (hasImage && currentModelMeta?.capabilities?.input?.image === false) {
        modalitiesToProcess.push({
          modality: "image",
          partsFilter: (p) => p.type === "file" && p.mime?.startsWith("image/"),
          defaultPrompt: "Descreva o conteúdo desta imagem em detalhes.",
        })
      }
      if (hasPdf && currentModelMeta?.capabilities?.input?.pdf === false) {
        modalitiesToProcess.push({
          modality: "pdf",
          partsFilter: (p) => p.type === "file" && p.mime === "application/pdf",
          defaultPrompt: "Faça um resumo executivo deste documento PDF.",
        })
      }
      if (hasAudio && currentModelMeta?.capabilities?.input?.audio === false) {
        modalitiesToProcess.push({
          modality: "audio",
          partsFilter: (p) => p.type === "file" && p.mime?.startsWith("audio/"),
          defaultPrompt: "Transcreva o áudio em detalhes.",
        })
      }

      for (const item of modalitiesToProcess) {
        const target = fallbackMap[item.modality]
        if (!target) continue

        const targetModelID = target.startsWith("agent:") ? undefined : target
        const targetModelMeta = targetModelID ? cache.models[targetModelID] : undefined

        if (targetModelMeta) {
          const supported = targetModelMeta.capabilities?.input?.[item.modality] === true
          if (!supported) continue
        }

        const modalityParts = parts.filter(item.partsFilter)
        if (modalityParts.length === 0) continue

        try {
          const desc = await runFallbackSubagent(target, modalityParts, item.defaultPrompt)
          
          const firstPart = modalityParts[0]!
          const label = item.modality === "image" ? "Imagem" : item.modality === "pdf" ? "PDF" : "Áudio"
          const fallbackLabel = target.startsWith("agent:") ? `@${target.slice(6)}` : target
          
          const textPart = {
            id: firstPart.id,
            sessionID: firstPart.sessionID,
            messageID: firstPart.messageID,
            type: "text" as const,
            text: `[Anexo de ${label} processado pelo fallback ${fallbackLabel}]\n${desc}`,
            synthetic: true,
          }

          const firstIndex = parts.indexOf(firstPart)
          if (firstIndex !== -1) {
            for (const p of modalityParts) {
              const idx = parts.indexOf(p)
              if (idx !== -1) parts.splice(idx, 1)
            }
            parts.splice(firstIndex, 0, textPart as any)
          }
        } catch (error) {
          const firstPart = modalityParts[0]!
          const label = item.modality === "image" ? "Imagem" : item.modality === "pdf" ? "PDF" : "Áudio"
          const errorMsg = error instanceof Error ? error.message : String(error)
          const textPart = {
            id: firstPart.id,
            sessionID: firstPart.sessionID,
            messageID: firstPart.messageID,
            type: "text" as const,
            text: `[Falha ao analisar o anexo de ${label}: ${errorMsg}]`,
            synthetic: true,
          }
          const firstIndex = parts.indexOf(firstPart)
          if (firstIndex !== -1) {
            for (const p of modalityParts) {
              const idx = parts.indexOf(p)
              if (idx !== -1) parts.splice(idx, 1)
            }
            parts.splice(firstIndex, 0, textPart as any)
          }
        }
      }
    },

    dispose: async () => {},
  }
}

export default { server: LiteLLMPlugin } satisfies PluginModule

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
  
  const fallbacks = readFallbackMap(auth.metadata)
  const fbLines: string[] = []
  for (const [m, target] of Object.entries(fallbacks)) {
    if (target) {
      const label = target.startsWith("agent:") ? `@${target.slice(6)}` : target
      fbLines.push(`  - ${m}: ${label}`)
    }
  }

  const lines = [
    "LiteLLM: Connected",
    `Endpoint: ${settings.endpoint}`,
    `API Key: ${maskSecret(settings.apiKey)}`,
    `Models: ${count}`,
    `Last refresh: ${lastRefresh}`,
  ]
  if (fbLines.length > 0) {
    lines.push("Fallbacks:")
    lines.push(...fbLines)
  }
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
