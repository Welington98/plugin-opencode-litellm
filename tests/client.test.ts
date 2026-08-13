import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { LiteLLMClient, LiteLLMError } from "../src/litellm/client"
import type { Server } from "bun"

type Handler = (req: Request) => Response | Promise<Response>
type MockServer = Server<unknown>

const handlers = new Map<string, Handler>()

function startMock(): MockServer {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      const handler = handlers.get(url.pathname)
      if (handler) return handler(req)
      return new Response("Not found", { status: 404 })
    },
  })
}

let server: MockServer | undefined

beforeEach(() => {
  handlers.clear()
  server = startMock()
})

afterEach(() => {
  server?.stop(true)
  server = undefined
})

const endpoint = () => server!.url.origin

describe("LiteLLMClient.fetchModels", () => {
  test("returns authorized models on 200", async () => {
    handlers.set("/v1/models", () =>
      Response.json({ object: "list", data: [{ id: "gpt-4o" }, { id: "claude-sonnet" }, { id: "gemini-pro" }] }),
    )
    const client = new LiteLLMClient({ endpoint: endpoint(), apiKey: "sk-test" })
    const result = await client.fetchModels()
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.data.map((m) => m.id)).toEqual(["gpt-4o", "claude-sonnet", "gemini-pro"])
  })

  test("sends the bearer token", async () => {
    let auth: string | null = null
    handlers.set("/v1/models", (req) => {
      auth = req.headers.get("authorization")
      return Response.json({ data: [{ id: "gpt-4o" }] })
    })
    const client = new LiteLLMClient({ endpoint: endpoint(), apiKey: "sk-secret-123" })
    await client.fetchModels()
    expect(String(auth ?? "")).toBe("Bearer sk-secret-123")
  })

  test("empty list maps to empty_list", async () => {
    handlers.set("/v1/models", () => Response.json({ data: [] }))
    const client = new LiteLLMClient({ endpoint: endpoint(), apiKey: "sk-test" })
    const result = await client.fetchModels()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("empty_list")
  })

  test("401 maps to auth_failed", async () => {
    handlers.set("/v1/models", () => new Response("unauthorized", { status: 401 }))
    const client = new LiteLLMClient({ endpoint: endpoint(), apiKey: "sk-test" })
    const result = await client.fetchModels()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe("auth_failed")
      expect(result.error.message).not.toContain("sk-test")
    }
  })

  test("404 maps to not_found", async () => {
    handlers.set("/v1/models", () => new Response("nope", { status: 404 }))
    const client = new LiteLLMClient({ endpoint: endpoint(), apiKey: "sk-test" })
    const result = await client.fetchModels()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("not_found")
  })

  test("429 maps to rate_limited", async () => {
    handlers.set("/v1/models", () => new Response("slow down", { status: 429 }))
    const client = new LiteLLMClient({ endpoint: endpoint(), apiKey: "sk-test" })
    const result = await client.fetchModels()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("rate_limited")
  })

  test("5xx maps to server_error", async () => {
    handlers.set("/v1/models", () => new Response("boom", { status: 503 }))
    const client = new LiteLLMClient({ endpoint: endpoint(), apiKey: "sk-test" })
    const result = await client.fetchModels()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("server_error")
  })

  test("non-JSON body maps to invalid_response", async () => {
    handlers.set("/v1/models", () => new Response("<html>not json</html>", { status: 200 }))
    const client = new LiteLLMClient({ endpoint: endpoint(), apiKey: "sk-test" })
    const result = await client.fetchModels()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("invalid_response")
  })

  test("wrong shape maps to invalid_response", async () => {
    handlers.set("/v1/models", () => Response.json({ foo: "bar" }))
    const client = new LiteLLMClient({ endpoint: endpoint(), apiKey: "sk-test" })
    const result = await client.fetchModels()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("invalid_response")
  })
})

describe("LiteLLMClient.testConnection", () => {
  test("reports ok + count", async () => {
    handlers.set("/v1/models", () => Response.json({ data: [{ id: "a" }, { id: "b" }] }))
    const client = new LiteLLMClient({ endpoint: endpoint(), apiKey: "sk-test" })
    const result = await client.testConnection()
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.count).toBe(2)
  })

  test("surfaces authentication failures", async () => {
    handlers.set("/v1/models", () => new Response("bad key", { status: 401 }))
    const client = new LiteLLMClient({ endpoint: endpoint(), apiKey: "sk-test" })
    const result = await client.testConnection()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("auth_failed")
  })
})

describe("LiteLLMClient.fetchModelGroupInfo", () => {
  test("parses capability metadata", async () => {
    handlers.set("/model_group/info", () =>
      Response.json({
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
        ],
      }),
    )
    const client = new LiteLLMClient({ endpoint: endpoint(), apiKey: "sk-test" })
    const result = await client.fetchModelGroupInfo()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.data[0]?.model_group).toBe("gpt-4o")
      expect(result.data.data[0]?.supports_vision).toBe(true)
    }
  })
})

describe("LiteLLMClient network classification", () => {
  test("connection refused maps to connection_refused", async () => {
    const client = new LiteLLMClient({ endpoint: "http://127.0.0.1:1", apiKey: "sk-test" })
    const result = await client.fetchModels()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("connection_refused")
  })

  test("timeout maps to timeout", async () => {
    handlers.set("/v1/models", async () => {
      await Bun.sleep(2000)
      return Response.json({ data: [{ id: "x" }] })
    })
    const client = new LiteLLMClient({ endpoint: endpoint(), apiKey: "sk-test" }, { timeoutMs: 100 })
    const result = await client.fetchModels()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("timeout")
  })
})

describe("LiteLLMError", () => {
  test("carries kind and status", () => {
    const err = new LiteLLMError("auth_failed", "Nope", 401)
    expect(err.kind).toBe("auth_failed")
    expect(err.status).toBe(401)
    expect(err.name).toBe("LiteLLMError")
  })
})
