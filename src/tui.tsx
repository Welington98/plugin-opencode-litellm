import type { Plugin } from "@opencode/plugin/tui"
import { PROVIDER_ID, type Modality } from "./types"
import { discoverModels, isCacheFresh } from "./litellm/discovery"
import {
  buildMetadata,
  clearLastError,
  mergeCacheMetadata,
  readCache,
  readFallbackMap,
  readLastError,
  registerAgentConfig,
  settingsFromAuth,
  writeFallbackMap,
} from "./config/settings"
import { validateApiKey, validateEndpoint } from "./config/validation"
import { LiteLLMClient } from "./litellm/client"
import { toModelMeta } from "./provider/models"
import { maskSecret, safeErrorMessage } from "./security/secrets"
import { readAuthRecord, removeAuthRecord, writeAuthRecord } from "./store/auth-file"
import { pluginVersion } from "./config/version"
import type { ModelsCache } from "./types"

/**
 * TUI-side entrypoint for the opencode-litellm plugin (OpenCode V2).
 *
 * Provides the `/litellm` slash command (setup, status, refresh, disconnect,
 * fallback) so the endpoint + API key are configured entirely inside OpenCode.
 *
 * V2 uses `context.keymap.layer` for slash commands and `context.ui.dialog`
 * for prompts/selects. Credentials are written straight to `auth.json` via the
 * shared `src/store/auth-file.ts` helpers — the same file the server plugin
 * reads — instead of the removed `client.auth.set` API.
 */
export default {
  id: "welington98.opencode-litellm.tui",
  setup(context: Plugin.Context) {
    const entries = [
      { sub: "status", title: "LiteLLM status", description: "Show LiteLLM connection status" },
      { sub: "setup", title: "Connect LiteLLM", description: "Configure LiteLLM endpoint and API key" },
      { sub: "refresh", title: "Refresh LiteLLM models", description: "Re-discover models from the LiteLLM proxy" },
      { sub: "fallback", title: "LiteLLM fallback", description: "Configure fallbacks for images, PDFs and audio" },
      { sub: "disconnect", title: "Disconnect LiteLLM", description: "Remove the LiteLLM credential and models" },
    ]
    // `palette: true` is required for the command to be listed in ctrl+p and in the `/` autocomplete.
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "welington98.litellm",
          title: "LiteLLM",
          description: "Connect, inspect and manage the LiteLLM proxy",
          group: "LiteLLM",
          palette: true,
          suggested: true,
          slash: { name: "litellm", arguments: true },
          run: (input?: string) => dispatch(context, input),
        },
        ...entries.map((entry) => ({
          id: `welington98.litellm.${entry.sub}`,
          title: entry.title,
          description: entry.description,
          group: "LiteLLM",
          palette: true,
          run: () => dispatch(context, entry.sub),
        })),
      ],
    }))
  },
}

/** Route the raw `/litellm <args>` input to the right handler. */
async function dispatch(context: Plugin.Context, input?: string): Promise<void> {
  const sub = (input ?? "").trim().toLowerCase()
  switch (sub) {
    case "":
    case "status":
      return showStatus(context)
    case "setup":
    case "connect":
      return setup(context)
    case "refresh":
      return refresh(context)
    case "disconnect":
      return disconnect(context)
    case "fallback":
      return configureFallback(context)
    default:
      context.ui.toast.show({
        variant: "warning",
        message: `Unknown /litellm command "${sub}". Use: setup, status, refresh, disconnect, fallback.`,
      })
      return showStatus(context)
  }
}

/** Best-effort reload so opencode re-reads the just-written auth/config. */
async function reload(context: Plugin.Context): Promise<void> {
  try {
    await context.client.location.reload()
  } catch {
    // reload is best-effort; opencode picks up changes on the next restart
  }
}

async function setup(context: Plugin.Context): Promise<void> {
  const endpointRaw = await context.ui.dialog.prompt({
    title: "LiteLLM Endpoint",
    placeholder: "https://litellm.example.com",
  })
  if (endpointRaw === undefined) return
  const endpoint = validateEndpoint(endpointRaw)
  if (!endpoint.ok) {
    context.ui.toast.show({ variant: "error", message: endpoint.message })
    return
  }

  const apiKey = await context.ui.dialog.prompt({
    title: "LiteLLM API Key",
    placeholder: "sk-",
  })
  if (apiKey === undefined) return
  const key = validateApiKey(apiKey)
  if (!key.ok) {
    context.ui.toast.show({ variant: "error", message: key.message })
    return
  }

  const settings = { endpoint: endpoint.value, apiKey: key.value }
  context.ui.toast.show({ variant: "info", message: "Testing LiteLLM connection..." })

  const conn = new LiteLLMClient(settings)
  const test = await conn.testConnection()
  if (!test.ok) {
    context.ui.toast.show({ variant: "error", message: test.error.message })
    return
  }

  let result
  try {
    result = await discoverModels(settings)
  } catch (error) {
    context.ui.toast.show({ variant: "error", message: safeErrorMessage(error, [settings.apiKey]) })
    return
  }

  const cache: ModelsCache = { fetchedAt: result.fetchedAt, models: {} }
  for (const [id, model] of Object.entries(result.models)) {
    cache.models[id] = toModelMeta(model)
  }
  const metadata = buildMetadata({ endpoint: endpoint.value, models: cache })

  try {
    await writeAuthRecord(PROVIDER_ID, { type: "api", key: key.value, metadata })
  } catch (error) {
    context.ui.toast.show({ variant: "error", message: safeErrorMessage(error, [key.value]) })
    return
  }

  context.ui.toast.show({
    variant: "success",
    message: `✓ Connected · ${Object.keys(result.models).length} models discovered`,
  })
  await reload(context)
}

async function refresh(context: Plugin.Context): Promise<void> {
  const auth = await readAuthRecord(PROVIDER_ID)
  const settings = auth ? settingsFromAuth(auth) : undefined
  if (!auth || !settings) {
    context.ui.toast.show({ variant: "error", message: "LiteLLM is not configured. Run /litellm setup first." })
    return
  }

  context.ui.toast.show({ variant: "info", message: "Refreshing LiteLLM models..." })
  try {
    const result = await discoverModels(settings)
    const cache: ModelsCache = { fetchedAt: result.fetchedAt, models: {} }
    for (const [id, model] of Object.entries(result.models)) {
      cache.models[id] = toModelMeta(model)
    }
    const metadata = mergeCacheMetadata(clearLastError(auth.metadata), cache)
    await writeAuthRecord(PROVIDER_ID, { ...auth, key: settings.apiKey, metadata })
    context.ui.toast.show({
      variant: "success",
      message: `✓ ${Object.keys(result.models).length} models refreshed`,
    })
    await reload(context)
  } catch (error) {
    context.ui.toast.show({ variant: "error", message: safeErrorMessage(error, [settings.apiKey]) })
  }
}

async function disconnect(context: Plugin.Context): Promise<void> {
  const auth = await readAuthRecord(PROVIDER_ID)
  if (!auth) {
    context.ui.toast.show({ variant: "info", message: "LiteLLM is not configured." })
    return
  }
  const ok = (await context.ui.dialog.confirm({
    title: "Disconnect LiteLLM",
    message: "Remove the stored credential and all discovered models?",
  })) === true
  if (!ok) return

  try {
    await removeAuthRecord(PROVIDER_ID)
  } catch (error) {
    context.ui.toast.show({ variant: "error", message: safeErrorMessage(error, []) })
    return
  }
  context.ui.toast.show({ variant: "success", message: "✓ Disconnected LiteLLM" })
  await reload(context)
}

async function showStatus(context: Plugin.Context): Promise<void> {
  const auth = await readAuthRecord(PROVIDER_ID)
  const settings = auth ? settingsFromAuth(auth) : undefined
  const cache = auth ? readCache(auth.metadata) : undefined
  const fresh = cache ? isCacheFresh(cache) : false
  const lastError = auth ? readLastError(auth.metadata) : undefined

  const statusText = settings ? (fresh ? "✓ Connected" : "Connected (stale cache)") : "Not configured"
  const modelCount = cache ? Object.keys(cache.models).length : 0
  const endpoint = settings?.endpoint ?? ""
  const keyLabel = settings ? maskSecret(settings.apiKey) : ""

  const fallbackMap = auth ? readFallbackMap(auth.metadata) : undefined
  const fbList: string[] = []
  if (fallbackMap) {
    for (const [m, target] of Object.entries(fallbackMap)) {
      if (target) {
        const label = target.startsWith("agent:") ? `@${target.slice(6)}` : target
        fbList.push(`${m} → ${label}`)
      }
    }
  }

  const lines = [
    "LiteLLM",
    `Status: ${statusText}`,
    settings
      ? `Endpoint: ${endpoint}\nAPI Key: ${keyLabel}`
      : "Run /litellm setup to configure your LiteLLM proxy.",
    `Models discovered: ${modelCount}`,
    `Version: ${pluginVersion()}`,
    `Last refresh: ${cache ? formatRelativeTime(cache.fetchedAt) : "never"}`,
  ]
  if (fbList.length > 0) {
    lines.push(`Fallbacks:\n${fbList.map((fb) => `  ${fb}`).join("\n")}`)
  }
  if (lastError) lines.push(`Last error: ${lastError.message}`)
  lines.push("/litellm setup · refresh · fallback · disconnect")

  await context.ui.dialog.alert({ title: "LiteLLM", message: lines.join("\n\n") })
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

async function configureFallback(context: Plugin.Context): Promise<void> {
  const auth = await readAuthRecord(PROVIDER_ID)
  const settings = auth ? settingsFromAuth(auth) : undefined
  const cache = auth ? readCache(auth.metadata) : undefined

  if (!auth || !settings || !cache) {
    context.ui.toast.show({ variant: "error", message: "LiteLLM is not configured. Run /litellm setup first." })
    return
  }

  // 1. Choose Modality
  const modality = await context.ui.dialog.select<Modality>({
    title: "Selecione a Modalidade",
    options: [
      { title: "Imagem (Vision)", value: "image", description: "Imagens anexadas no chat" },
      { title: "PDF (Document)", value: "pdf", description: "Documentos PDF anexados" },
      { title: "Áudio (Audio)", value: "audio", description: "Arquivos de áudio ou gravações" },
    ],
  })
  if (!modality) return

  // 2. Choose Action
  const action = await context.ui.dialog.select<"model" | "agent" | "clear">({
    title: "Tipo de Fallback",
    options: [
      { title: "Modelo Padrão (Subagent Nativo)", value: "model", description: "Redireciona para um modelo vision/media padrão do LiteLLM" },
      { title: "Criar Subagent Personalizado (Livre)", value: "agent", description: "Cria um novo subagent com prompt e modelo customizados" },
      { title: "Limpar Fallback (Desativar)", value: "clear", description: "Remove o fallback configurado para esta modalidade" },
    ],
  })
  if (!action) return

  const fallbackMap = readFallbackMap(auth.metadata)

  if (action === "clear") {
    fallbackMap[modality] = ""
    const metadata = writeFallbackMap(auth.metadata, fallbackMap)
    await writeAuthRecord(PROVIDER_ID, { ...auth, key: settings.apiKey, metadata })
    context.ui.toast.show({ variant: "success", message: `✓ Fallback de ${modality} limpo com sucesso.` })
    return
  }

  // Filter models that support this modality
  const capableModels = Object.entries(cache.models)
    .filter(([_, m]) => m.capabilities?.input?.[modality] === true)
    .map(([id, m]) => ({ title: m.name || id, value: id, description: id }))

  if (capableModels.length === 0) {
    context.ui.toast.show({ variant: "error", message: `Nenhum modelo descoberto suporta a modalidade "${modality}".` })
    return
  }

  if (action === "model") {
    // Standard model fallback
    const selectedModel = await context.ui.dialog.select<string>({
      title: `Selecione o Modelo para Fallback de ${modality}`,
      options: capableModels,
    })
    if (!selectedModel) return

    fallbackMap[modality] = selectedModel
    const metadata = writeFallbackMap(auth.metadata, fallbackMap)
    await writeAuthRecord(PROVIDER_ID, { ...auth, key: settings.apiKey, metadata })
    context.ui.toast.show({ variant: "success", message: `✓ Fallback de ${modality} definido para ${selectedModel}` })
    return
  }

  if (action === "agent") {
    // Custom subagent flow
    const agentNameRaw = await context.ui.dialog.prompt({
      title: "Nome do Subagent (kebab-case)",
      placeholder: `analisar-${modality}`,
    })
    if (!agentNameRaw) return
    const agentName = agentNameRaw.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-")
    if (!agentName) {
      context.ui.toast.show({ variant: "error", message: "Nome do subagent inválido." })
      return
    }

    const defaultPrompt = modality === "image"
      ? "Você é um subagent de visão. Descreva a imagem em detalhes em português."
      : modality === "pdf"
      ? "Você é um subagent de análise. Extraia os pontos principais do PDF em português."
      : "Você é um subagent de transcrição. Transcreva o áudio em português."

    const systemPrompt = await context.ui.dialog.prompt({
      title: "Instruções do Sistema (System Prompt)",
      placeholder: defaultPrompt,
      value: defaultPrompt,
    })
    if (!systemPrompt) return

    const selectedModel = await context.ui.dialog.select<string>({
      title: `Selecione o Modelo para @${agentName}`,
      options: capableModels,
    })
    if (!selectedModel) return

    context.ui.toast.show({ variant: "info", message: `Registrando subagent @${agentName}...` })

    // Write the agent directly to opencode.json (the V2 client can only update
    // the shell, so we use the same file helper the server plugin relies on).
    const reg = await registerAgentConfig(agentName, `litellm/${selectedModel}`, systemPrompt)
    if (!reg.ok) {
      context.ui.toast.show({ variant: "error", message: `Failed to save agent config: ${reg.error ?? "unknown error"}` })
      return
    }

    // Set fallback to agent:<name>
    fallbackMap[modality] = `agent:${agentName}`
    const metadata = writeFallbackMap(auth.metadata, fallbackMap)
    await writeAuthRecord(PROVIDER_ID, { ...auth, key: settings.apiKey, metadata })

    context.ui.toast.show({
      variant: "success",
      message: `✓ Subagent @${agentName} registrado e definido como fallback de ${modality}!`,
    })
    await reload(context)
  }
}
