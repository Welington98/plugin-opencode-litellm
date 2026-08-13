import { describe, expect, test } from "bun:test"
import { buildMetadata, clearLastError, mergeCacheMetadata, readCache, readLastError, settingsFromAuth } from "../src/config/settings"
import type { ApiAuth } from "@opencode-ai/sdk/v2"
import type { ModelsCache } from "../src/types"
import { buildModel, toModelMeta } from "../src/provider/models"

const settingsEndpoint = "https://litellm.example.com"
const model = buildModel("gpt-4o", { endpoint: settingsEndpoint, apiKey: "sk-test-12345678" })
const meta = toModelMeta(model)

const cache: ModelsCache = {
  fetchedAt: 1_700_000_000_000,
  models: { "gpt-4o": meta },
}

function auth(overrides?: Partial<ApiAuth>): ApiAuth {
  return {
    type: "api",
    key: "sk-test-12345678",
    metadata: buildMetadata({ endpoint: settingsEndpoint, models: cache }),
    ...overrides,
  }
}

describe("settingsFromAuth", () => {
  test("extracts endpoint and key", () => {
    const settings = settingsFromAuth(auth())
    expect(settings).toEqual({ endpoint: settingsEndpoint, apiKey: "sk-test-12345678" })
  })

  test("returns undefined when not configured", () => {
    expect(settingsFromAuth(undefined)).toBeUndefined()
    expect(settingsFromAuth({ type: "oauth", refresh: "r", access: "a", expires: 1 } as unknown as ApiAuth)).toBeUndefined()
    expect(settingsFromAuth({ ...auth(), key: "" })).toBeUndefined()
  })

  test("returns undefined when endpoint is missing", () => {
    const { metadata: _metadata, ...rest } = auth()
    expect(settingsFromAuth(rest as ApiAuth)).toBeUndefined()
  })
})

describe("buildMetadata + readCache", () => {
  test("round-trips endpoint + models", () => {
    const metadata = buildMetadata({ endpoint: settingsEndpoint, models: cache })
    const decoded = readCache(metadata)
    expect(decoded?.fetchedAt).toBe(cache.fetchedAt)
    expect(decoded?.models["gpt-4o"]).toBeDefined()
  })

  test("readCache tolerates missing/empty metadata", () => {
    expect(readCache(undefined)).toBeUndefined()
    expect(readCache({})).toBeUndefined()
  })
})

describe("mergeCacheMetadata", () => {
  test("updates cache fields and preserves endpoint", () => {
    const metadata = buildMetadata({ endpoint: settingsEndpoint, models: cache })
    const next = mergeCacheMetadata(metadata, { fetchedAt: 999, models: cache.models })
    expect(next["endpoint"]).toBe(settingsEndpoint)
    expect(next["models_fetched_at"]).toBe("999")
    expect(next["schema"]).toBe("1")
  })

  test("adds schema and allows readCache even if input is basic (e.g. from CLI login)", () => {
    const basicMetadata = { endpoint: settingsEndpoint }
    const next = mergeCacheMetadata(basicMetadata, cache)
    expect(next["schema"]).toBe("1")
    const decoded = readCache(next)
    expect(decoded).toBeDefined()
    expect(decoded?.fetchedAt).toBe(cache.fetchedAt)
  })
})

describe("clearLastError", () => {
  test("removes error fields", () => {
    const withError = { ...buildMetadata({ endpoint: "x", models: cache }), last_error: "boom", last_error_at: "123" }
    const cleared = clearLastError(withError)
    expect(cleared["last_error"]).toBeUndefined()
    expect(cleared["last_error_at"]).toBeUndefined()
  })
})

describe("readLastError", () => {
  test("reads stored error", () => {
    const withError = { last_error: "boom", last_error_at: "123" }
    expect(readLastError(withError)).toEqual({ message: "boom", at: 123 })
    expect(readLastError({})).toBeUndefined()
  })
})
