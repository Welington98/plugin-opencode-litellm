import type { TuiPlugin, TuiPluginApi, TuiDialogStack } from "@opencode-ai/plugin/tui"
import { PROVIDER_ID } from "./types"
import { discoverModels, isCacheFresh } from "./litellm/discovery"
import { readCache, settingsFromAuth } from "./config/settings"
import { validateApiKey, validateEndpoint } from "./config/validation"
import { LiteLLMClient } from "./litellm/client"
import { buildMetadata } from "./config/settings"
import { toModelMeta } from "./provider/models"
import { maskSecret, safeErrorMessage } from "./security/secrets"
import { readAuthRecord, removeAuthRecord } from "./store/auth-file"
import type { ModelsCache } from "./types"

/**
 * TUI-side entrypoint for the opencode-litellm plugin.
 *
 * Provides the `/litellm` slash commands (setup, status, refresh, disconnect)
 * so the endpoint + API key are configured entirely inside OpenCode.
 */
export const LiteLLMTuiPlugin: TuiPlugin = async (api) => {
  if (!api.command) {
    console.warn("[opencode-litellm] TUI command API unavailable; /litellm commands not registered")
    return
  }
  const disposeCommands = api.command.register(() => [
    {
      value: "litellm",
      title: "LiteLLM",
      description: "Show LiteLLM connection status",
      category: "LiteLLM",
      slash: { name: "litellm" },
      onSelect: () => showStatus(api),
    },
    {
      value: "litellm-setup",
      title: "Connect LiteLLM",
      description: "Configure LiteLLM endpoint and API key",
      category: "LiteLLM",
      slash: { name: "litellm setup" },
      onSelect: () => setup(api),
    },
    {
      value: "litellm-status",
      title: "LiteLLM status",
      description: "Show LiteLLM connection status",
      category: "LiteLLM",
      slash: { name: "litellm status" },
      onSelect: () => showStatus(api),
    },
    {
      value: "litellm-refresh",
      title: "Refresh LiteLLM models",
      description: "Re-discover models from the LiteLLM proxy",
      category: "LiteLLM",
      slash: { name: "litellm refresh" },
      onSelect: () => refresh(api),
    },
    {
      value: "litellm-disconnect",
      title: "Disconnect LiteLLM",
      description: "Remove the LiteLLM credential and discovered models",
      category: "LiteLLM",
      slash: { name: "litellm disconnect" },
      onSelect: () => disconnect(api),
    },
  ])
  api.lifecycle.onDispose(disposeCommands)
}

export default LiteLLMTuiPlugin

/** Prompt for a single text value using the native dialog. */
function promptText(
  api: TuiPluginApi,
  title: string,
  placeholder: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    api.ui.dialog.replace(
      () => (
        <api.ui.DialogPrompt
          title={title}
          placeholder={placeholder}
          onConfirm={(value) => resolve(value)}
          onCancel={() => resolve(null)}
        />
      ),
      () => resolve(null),
    )
  })
}

/** Prompt for confirmation (yes/no) using the native dialog. */
function confirm(
  api: TuiPluginApi,
  title: string,
  message: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    api.ui.dialog.replace(
      () => (
        <api.ui.DialogConfirm
          title={title}
          message={message}
          onConfirm={() => resolve(true)}
          onCancel={() => resolve(false)}
        />
      ),
      () => resolve(false),
    )
  })
}

async function setup(api: TuiPluginApi): Promise<void> {
  const endpointRaw = await promptText(api, "LiteLLM Endpoint", "https://litellm.example.com")
  if (endpointRaw === null) return
  const endpoint = validateEndpoint(endpointRaw)
  if (!endpoint.ok) {
    api.ui.toast({ variant: "error", message: endpoint.message })
    return
  }

  const apiKey = await promptText(api, "LiteLLM API Key", "sk-")
  if (apiKey === null) return
  const key = validateApiKey(apiKey)
  if (!key.ok) {
    api.ui.toast({ variant: "error", message: key.message })
    return
  }

  const settings = { endpoint: endpoint.value, apiKey: key.value }
  api.ui.toast({ variant: "info", message: "Testing LiteLLM connection..." })

  const conn = new LiteLLMClient(settings)
  const test = await conn.testConnection()
  if (!test.ok) {
    api.ui.toast({ variant: "error", message: test.error.message })
    return
  }

  let result: { models: Record<string, import("./types").LiteLLMModel>; fetchedAt: number }
  try {
    result = await discoverModels(settings)
  } catch (error) {
    api.ui.toast({ variant: "error", message: safeErrorMessage(error, [settings.apiKey]) })
    return
  }

  const cache: ModelsCache = { fetchedAt: result.fetchedAt, models: {} }
  for (const [id, model] of Object.entries(result.models)) {
    cache.models[id] = toModelMeta(model)
  }
  const metadata = buildMetadata({ endpoint: endpoint.value, models: cache })

  const saved = await api.client.auth.set({
    providerID: PROVIDER_ID,
    auth: { type: "api", key: key.value, metadata },
  })
  if (saved.error) {
    api.ui.toast({ variant: "error", message: safeErrorMessage(saved.error, [key.value]) })
    return
  }

  api.ui.toast({
    variant: "success",
    message: `✓ Connected · ${Object.keys(result.models).length} models discovered · restarting instance`,
  })
  await api.client.instance.dispose()
}

async function refresh(api: TuiPluginApi): Promise<void> {
  const auth = await readAuthRecord(PROVIDER_ID)
  const settings = auth ? settingsFromAuth(auth) : undefined
  if (!settings) {
    api.ui.toast({ variant: "error", message: "LiteLLM is not configured. Run /litellm setup first." })
    return
  }

  api.ui.toast({ variant: "info", message: "Refreshing LiteLLM models..." })
  try {
    const result = await discoverModels(settings)
    const cache: ModelsCache = { fetchedAt: result.fetchedAt, models: {} }
    for (const [id, model] of Object.entries(result.models)) {
      cache.models[id] = toModelMeta(model)
    }
    const metadata = buildMetadata({ endpoint: settings.endpoint, models: cache })
    await api.client.auth.set({
      providerID: PROVIDER_ID,
      auth: { type: "api", key: settings.apiKey, metadata },
    })
    api.ui.toast({
      variant: "success",
      message: `✓ ${Object.keys(result.models).length} models refreshed · restarting instance`,
    })
    await api.client.instance.dispose()
  } catch (error) {
    api.ui.toast({ variant: "error", message: safeErrorMessage(error, [settings.apiKey]) })
  }
}

async function disconnect(api: TuiPluginApi): Promise<void> {
  const auth = await readAuthRecord(PROVIDER_ID)
  if (!auth) {
    api.ui.toast({ variant: "info", message: "LiteLLM is not configured." })
    return
  }
  const ok = await confirm(api, "Disconnect LiteLLM", "Remove the stored credential and all discovered models?")
  if (!ok) return

  await removeAuthRecord(PROVIDER_ID)
  api.ui.toast({ variant: "success", message: "✓ Disconnected LiteLLM · restarting instance" })
  await api.client.instance.dispose()
}

async function showStatus(api: TuiPluginApi): Promise<void> {
  const theme = api.theme.current
  const auth = await readAuthRecord(PROVIDER_ID)
  const settings = auth ? settingsFromAuth(auth) : undefined
  const cache = auth ? readCache(auth.metadata) : undefined
  const fresh = cache ? isCacheFresh(cache) : false

  const statusColor = settings ? theme.success : theme.error
  const statusText = settings ? (fresh ? "✓ Connected" : "Connected (stale cache)") : "Not configured"
  const modelCount = cache ? Object.keys(cache.models).length : 0
  const endpoint = settings?.endpoint ?? ""
  const keyLabel = settings ? maskSecret(settings.apiKey) : ""
  const lastRefresh = cache ? formatRelativeTime(cache.fetchedAt) : "never"

  api.ui.dialog.replace(() => (
    <box flexDirection="column" paddingX={2} paddingY={1} gap={1}>
      <text fg={theme.text}>LiteLLM</text>
      <text fg={statusColor}>Status: {statusText}</text>
      {settings ? (
        <>
          <text fg={theme.text}>Endpoint: {endpoint}</text>
          <text fg={theme.text}>API Key: {keyLabel}</text>
        </>
      ) : (
        <text fg={theme.textMuted}>Run /litellm setup to configure your LiteLLM proxy.</text>
      )}
      <text fg={theme.text}>Models discovered: {modelCount}</text>
      <text fg={theme.textMuted}>Last refresh: {lastRefresh}</text>
      <text fg={theme.textMuted}>
        /litellm setup · /litellm refresh · /litellm disconnect
      </text>
    </box>
  ))
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
