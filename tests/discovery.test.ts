import { describe, expect, test } from "bun:test"
import { buildModel, fromModelMeta, toModelMeta } from "../src/provider/models"
import { decodeCache, encodeCache, cacheToModels, isCacheFresh, discoverModels, parseEndpoint } from "../src/litellm/discovery"
import { LiteLLMError } from "../src/litellm/client"
import type { LiteLLMSettings } from "../src/types"

const settings: LiteLLMSettings = { endpoint: "https://litellm.example.com", apiKey: "sk-test-12345678" }

describe("buildModel", () => {
  const model = buildModel("gpt-4o", settings)

  test("uses the OpenAI-compatible api pointing at <endpoint>/v1", () => {
    expect(model.api).toEqual({ id: "gpt-4o", url: "https://litellm.example.com/v1", npm: "@ai-sdk/openai-compatible" })
    expect(model.providerID).toBe("litellm")
  })

  test("starts active with chat defaults", () => {
    expect(model.status).toBe("active")
    expect(model.capabilities.input.text).toBe(true)
    expect(model.capabilities.toolcall).toBe(true)
  })
})

describe("model cache round-trip", () => {
  const model = buildModel("gpt-4o", settings)
  const meta = toModelMeta(model)
  const cache = { fetchedAt: Date.now(), models: { "gpt-4o": meta } }

  test("toModelMeta strips id/providerID", () => {
    expect(meta).not.toHaveProperty("id")
    expect(meta).not.toHaveProperty("providerID")
  })

  test("fromModelMeta restores a full model", () => {
    const restored = fromModelMeta("gpt-4o", meta)
    expect(restored.id).toBe("gpt-4o")
    expect(restored.providerID).toBe("litellm")
    expect(restored.api.url).toBe("https://litellm.example.com/v1")
  })

  test("encodeCache + decodeCache round-trips", () => {
    const encoded = encodeCache(cache)
    const decoded = decodeCache(encoded)
    expect(decoded?.fetchedAt).toBe(cache.fetchedAt)
    expect(Object.keys(decoded?.models ?? {})).toEqual(["gpt-4o"])
  })

  test("decodeCache returns undefined for corrupted data", () => {
    expect(decodeCache(undefined)).toBeUndefined()
    expect(decodeCache({ schema: "1", models_fetched_at: "nope", models_cache: "{}" })).toBeUndefined()
    expect(decodeCache({ schema: "999", models_fetched_at: "123", models_cache: "{}" })).toBeUndefined()
  })

  test("cacheToModels rehydrates the catalog", () => {
    const models = cacheToModels(cache)
    const model = models["gpt-4o"]
    expect(model).toBeDefined()
    expect(model?.name).toBe("gpt-4o")
    expect(model?.providerID).toBe("litellm")
  })
})

describe("isCacheFresh", () => {
  test("fresh within TTL", () => {
    const cache = { fetchedAt: Date.now() - 60_000, models: {} }
    expect(isCacheFresh(cache)).toBe(true)
  })

  test("stale past TTL", () => {
    const cache = { fetchedAt: Date.now() - 10 * 60_000, models: {} }
    expect(isCacheFresh(cache)).toBe(false)
  })

  test("undefined is never fresh", () => {
    expect(isCacheFresh(undefined)).toBe(false)
  })
})

describe("parseEndpoint", () => {
  test("normalizes valid endpoints", () => {
    expect(parseEndpoint("https://litellm.example.com/")).toBe("https://litellm.example.com")
  })

  test("returns undefined for invalid input", () => {
    expect(parseEndpoint("")).toBeUndefined()
    expect(parseEndpoint(undefined)).toBeUndefined()
    expect(parseEndpoint("not a url")).toBeUndefined()
  })
})

describe("discoverModels", () => {
  test("throws LiteLLMError for a failing client request", async () => {
    const badSettings = { ...settings, endpoint: "http://127.0.0.1:1" }
    await expect(discoverModels(badSettings)).rejects.toThrow(LiteLLMError)
  })
})
