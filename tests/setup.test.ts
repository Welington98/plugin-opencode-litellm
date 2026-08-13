import { describe, expect, test } from "bun:test"
import type { Server } from "bun"
import { discoverModels } from "../src/litellm/discovery"
import { LiteLLMClient } from "../src/litellm/client"
import { buildProviderConfig } from "../src/provider/config-provider"
import { buildMetadata, readCache, settingsFromAuth } from "../src/config/settings"
import { toModelMeta } from "../src/provider/models"
import type { ModelsCache, LiteLLMSettings } from "../src/types"

type MockServer = Server<unknown>

const MODEL_IDS = ["gpt-4o", "claude-3-5-sonnet", "gemini-pro"]
const KEY = "sk-setup-test-1234"
const ENDPOINT_BASE = "https://litellm.example.com"

function startServer(): MockServer {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/v1/models") {
        return Response.json({
          object: "list",
          data: MODEL_IDS.map((id) => ({ id, object: "model", created: 1700000000, owned_by: "litellm" })),
        })
      }
      if (url.pathname === "/model_group/info") {
        return Response.json({
          data: [
            {
              model_group: "gpt-4o",
              providers: ["openai"],
              mode: "chat",
              supports_vision: true,
              supports_function_calling: true,
              max_input_tokens: 128000,
              max_output_tokens: 4096,
            },
            {
              model_group: "claude-3-5-sonnet",
              providers: ["anthropic"],
              mode: "chat",
              supports_vision: true,
              supports_function_calling: true,
            },
            {
              model_group: "gemini-pro",
              providers: ["vertex_ai"],
              mode: "chat",
              supports_function_calling: true,
            },
          ],
        })
      }
      return new Response("Not found", { status: 404 })
    },
  })
}

describe("setup flow (mock LiteLLM proxy)", () => {
  test("testConnection succeeds with the endpoint + key", async () => {
    const server = startServer()
    const settings: LiteLLMSettings = { endpoint: server.url.origin, apiKey: KEY }
    const result = await new LiteLLMClient(settings).testConnection()
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.count).toBe(3)
    server.stop(true)
  })

  test("discovers all authorized models", async () => {
    const server = startServer()
    const result = await discoverModels({ endpoint: server.url.origin, apiKey: KEY })
    expect(Object.keys(result.models).sort()).toEqual([...MODEL_IDS].sort())
    server.stop(true)
  })

  test("discovers vision + tools + limits from metadata", async () => {
    const server = startServer()
    const result = await discoverModels({ endpoint: server.url.origin, apiKey: KEY })
    const gpt4o = result.models["gpt-4o"]
    expect(gpt4o).toBeDefined()
    expect(gpt4o?.capabilities.input.image).toBe(true)
    expect(gpt4o?.capabilities.attachment).toBe(true)
    expect(gpt4o?.capabilities.toolcall).toBe(true)
    expect(gpt4o?.limit.context).toBe(128000)
    expect(gpt4o?.limit.output).toBe(4096)
    server.stop(true)
  })

  test("endpoint metadata is honored at the OpenAI-compatible api url", async () => {
    const server = startServer()
    const result = await discoverModels({ endpoint: server.url.origin, apiKey: KEY })
    const model = result.models["gpt-4o"]
    expect(model?.api.url).toBe(`${server.url.origin}/v1`)
    expect(model?.api.npm).toBe("@ai-sdk/openai-compatible")
    server.stop(true)
  })

  test("the cached catalog persists and round-trips through metadata", async () => {
    const server = startServer()
    const result = await discoverModels({ endpoint: server.url.origin, apiKey: KEY })

    const cache: ModelsCache = { fetchedAt: result.fetchedAt, models: {} }
    for (const [id, model] of Object.entries(result.models)) cache.models[id] = toModelMeta(model)

    const metadata = buildMetadata({ endpoint: server.url.origin, models: cache })
    const restored = readCache(metadata)
    expect(restored).toBeDefined()
    expect(Object.keys(restored?.models ?? {})).toEqual(Object.keys(cache.models))

    const auth = { type: "api" as const, key: KEY, metadata }
    const settings = settingsFromAuth(auth)
    expect(settings?.endpoint).toBe(server.url.origin)
    expect(settings?.apiKey).toBe(KEY)
    server.stop(true)
  })

  test("buildProviderConfig produces a valid provider config with modalities", async () => {
    const server = startServer()
    const result = await discoverModels({ endpoint: server.url.origin, apiKey: KEY })
    const config = buildProviderConfig(result.models)
    expect(config.name).toBe("LiteLLM")
    const gpt4o = config.models?.["gpt-4o"]
    expect(gpt4o?.modalities?.input).toContain("image")
    expect(gpt4o?.modalities?.input).toContain("text")
    expect(gpt4o?.provider?.npm).toBe("@ai-sdk/openai-compatible")
    expect((gpt4o?.provider as { api?: string } | undefined)?.api).toBe(`${server.url.origin}/v1`)
    expect(gpt4o?.tool_call).toBe(true)
    server.stop(true)
  })
})

describe("endpoint consistency", () => {
  test("api base URL is derived from the user-provided endpoint", async () => {
    const server = startServer()
    const result = await discoverModels({ endpoint: server.url.origin, apiKey: KEY })
    expect(result.models["gpt-4o"]?.api.url).toBe(`${server.url.origin}/v1`)
    expect(result.models["gpt-4o"]?.api.url).not.toContain("litellm.example.com")
    server.stop(true)
  })
})
