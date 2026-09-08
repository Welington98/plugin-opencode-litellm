import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const PLUGIN_NAME = "@welington98/opencode-litellm"
const FALLBACK = "unknown"

let cached: string | undefined

/**
 * Resolve the installed plugin version by walking up from this module and
 * reading the first `package.json` that names the plugin. Works both from the
 * published `dist/` bundle and from the source tree during tests.
 */
export function pluginVersion(): string {
  if (cached !== undefined) return cached
  cached = resolveVersion()
  return cached
}

function resolveVersion(): string {
  try {
    let dir = dirname(fileURLToPath(import.meta.url))
    for (let i = 0; i < 10; i++) {
      try {
        const raw = readFileSync(join(dir, "package.json"), "utf8")
        const pkg = JSON.parse(raw) as { name?: unknown; version?: unknown }
        if (pkg.name === PLUGIN_NAME && typeof pkg.version === "string" && pkg.version.length > 0) {
          return pkg.version
        }
      } catch {
        // keep walking up
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    // ignore
  }
  return FALLBACK
}
