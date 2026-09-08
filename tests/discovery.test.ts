import { describe, expect, test } from "bun:test"
import { buildModel, fromModelMeta, toModelMeta } from "../src/provider/models"
import { decodeCache, encodeCache, cacheToModels, isCacheFresh, discoverModels, parseEndpoint, findMeta } from "../src/litellm/discovery"
import { LiteLLMError } from "../src/litellm/client"
import type { LiteLLMModelGroup, LiteLLMSettings } from "../src/types"

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

  test("drops blocked (paused/disabled) models and non-chat models", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === "/v1/models") {
          return Response.json({
            data: [
              { id: "gpt-4o" },
              { id: "gpt-4o-mini" },
              { id: "openai/text-embedding-3-large" },
              { id: "openai/dall-e-2" },
              { id: "gpt-5.4" },
            ],
          })
        }
        if (url.pathname === "/v1/model/info") {
          return Response.json({
            data: [
              { model_name: "gpt-4o", model_info: { blocked: false, mode: "chat", supports_vision: true } },
              { model_name: "gpt-4o-mini", model_info: { blocked: false, mode: "chat" } },
              { model_name: "openai/text-embedding-3-large", model_info: { blocked: false, mode: "embedding" } },
              { model_name: "openai/dall-e-2", model_info: { blocked: false, mode: "image_generation" } },
              { model_name: "gpt-5.4", model_info: { blocked: true, mode: "chat" } },
            ],
          })
        }
        return new Response("Not found", { status: 404 })
      },
    })

    try {
      const result = await discoverModels({ endpoint: server.url.origin, apiKey: "sk-test-12345678" })
      const ids = Object.keys(result.models)
      expect(ids).toEqual(["gpt-4o", "gpt-4o-mini"])
    } finally {
      server.stop(true)
    }
  })
})

describe("findMeta", () => {
  const byId = new Map<string, LiteLLMModelGroup>([
    ["gpt-4o", { model_group: "gpt-4o", mode: "chat" }],
    ["dall-e-2", { model_group: "dall-e-2", mode: "image_generation" }],
    ["openai/text-embedding-3-large", { model_group: "openai/text-embedding-3-large", mode: "embedding" }],
  ])

  test("matches exact id first", () => {
    expect(findMeta("gpt-4o", byId)?.mode).toBe("chat")
  })

  test("strips provider prefix", () => {
    expect(findMeta("openai/gpt-4o", byId)?.mode).toBe("chat")
  })

  test("strips multiple segments (image size/quality variants)", () => {
    expect(findMeta("openai/1024-x-1024/dall-e-2", byId)?.mode).toBe("image_generation")
  })

  test("returns undefined when nothing matches", () => {
    expect(findMeta("totally/unknown/model", byId)).toBeUndefined()
  })
})
