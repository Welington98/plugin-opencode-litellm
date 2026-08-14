import os from "os"
import path from "path"
import type { ApiAuth } from "@opencode-ai/sdk/v2"

/**
 * Read and remove the opencode auth store directly on disk.
 *
 * The plugin's config hook runs before the provider catalog is assembled, and
 * the v1 SDK client has no working `auth.get`/`auth.remove` for providers, so
 * we operate on `$XDG_DATA_HOME/opencode/auth.json` (mode 0600) directly —
 * the same file opencode reads/writes. All cache writes during runtime still
 * go through the official `client.auth.set` API.
 */

export function authFilePath(): string {
  const xdg = process.env.XDG_DATA_HOME
  if (xdg) return path.join(xdg, "opencode", "auth.json")
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA
    return local ? path.join(local, "opencode", "auth.json") : path.join(os.homedir(), "AppData", "Local", "opencode", "auth.json")
  }
  return path.join(os.homedir(), ".local", "share", "opencode", "auth.json")
}

export function configFilePath(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  if (xdg) return path.join(xdg, "opencode", "opencode.json")
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA
    return local ? path.join(local, "opencode", "opencode.json") : path.join(os.homedir(), "AppData", "Local", "opencode", "opencode.json")
  }
  return path.join(os.homedir(), ".config", "opencode", "opencode.json")
}

async function readAll(): Promise<Record<string, unknown>> {
  try {
    const file = Bun.file(authFilePath())
    const json = await file.json()
    if (json && typeof json === "object") return json as Record<string, unknown>
  } catch {
    // file missing or invalid JSON
  }
  return {}
}

export async function readAuthRecord(providerID: string): Promise<ApiAuth | undefined> {
  const json = await readAll()
  const record = json[providerID]
  if (!record || typeof record !== "object") return undefined
  const auth = record as Partial<ApiAuth>
  if (auth.type !== "api") return undefined
  if (typeof auth.key !== "string" || auth.key.length === 0) return undefined
  return auth as ApiAuth
}

/** Remove a provider credential from the auth store. */
export async function removeAuthRecord(providerID: string): Promise<void> {
  const json = await readAll()
  if (!(providerID in json)) return
  delete json[providerID]
  await Bun.write(authFilePath(), JSON.stringify(json, null, 2))
}
