/**
 * A tiny mock LiteLLM proxy for local development and testing.
 *
 * Usage:
 *   bun scripts/mock-litellm.ts [port]
 *
 * Serves:
 *   GET /v1/models           -> OpenAI-style model list
 *   GET /model_group/info    -> capability metadata (vision, tools, limits)
 *   GET /v1/model/info       -> fallback metadata endpoint
 *   GET /v1/chat/completions -> simple echo completion
 *
 * The "API key" is not validated, so any non-empty `Authorization: Bearer <key>`
 * works. Set MOCK_LITELLM_DENY=1 to reject all requests (simulate auth failure).
 */
import type { Server } from "bun"

const MODELS = [
  {
    id: "gpt-4o",
    supports_vision: true,
    supports_function_calling: true,
    supports_temperature: true,
    supports_reasoning: false,
    max_input_tokens: 128_000,
    max_output_tokens: 4_096,
    input_cost_per_token: 0.000005,
    output_cost_per_token: 0.000015,
  },
  {
    id: "claude-3-5-sonnet",
    supports_vision: true,
    supports_function_calling: true,
    supports_temperature: true,
    max_input_tokens: 200_000,
    max_output_tokens: 8_192,
  },
  {
    id: "gemini-pro",
    supports_vision: false,
    supports_function_calling: true,
    supports_temperature: true,
    max_input_tokens: 1_048_576,
    max_output_tokens: 8_192,
  },
  {
    id: "deepseek-r1",
    supports_vision: false,
    supports_function_calling: true,
    supports_reasoning: true,
    max_input_tokens: 128_000,
    max_output_tokens: 8_192,
  },
]

const port = Number(process.argv[2] ?? 4000)

const server: Server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url)
    const auth = req.headers.get("authorization")

    if (process.env.MOCK_LITELLM_DENY === "1") {
      return new Response(JSON.stringify({ error: { message: "invalid api key" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    }
    if (!auth?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: { message: "missing api key" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    }

    if (url.pathname === "/v1/models") {
      return Response.json({
        object: "list",
        data: MODELS.map((m) => ({ id: m.id, object: "model", created: 1700000000, owned_by: "litellm" })),
      })
    }

    if (url.pathname === "/model_group/info") {
      return Response.json({
        data: MODELS.map((m) => ({
          model_group: m.id,
          providers: ["mock"],
          mode: "chat",
          supports_vision: m.supports_vision,
          supports_function_calling: m.supports_function_calling,
          supports_temperature: m.supports_temperature,
          supports_reasoning: m.supports_reasoning,
          max_input_tokens: m.max_input_tokens,
          max_output_tokens: m.max_output_tokens,
          input_cost_per_token: m.input_cost_per_token,
          output_cost_per_token: m.output_cost_per_token,
        })),
      })
    }

    if (url.pathname === "/v1/model/info") {
      return Response.json({
        data: MODELS.map((m) => ({
          model_name: m.id,
          model_info: {
            supports_vision: m.supports_vision,
            supports_function_calling: m.supports_function_calling,
            max_input_tokens: m.max_input_tokens,
            max_output_tokens: m.max_output_tokens,
          },
        })),
      })
    }

    if (url.pathname === "/v1/chat/completions") {
      const body = await req.json().catch(() => ({}))
      console.log(`[mock] chat.completions model=${JSON.stringify(body.model)} auth=${auth}`)
      return Response.json({
        id: "chatcmpl-mock",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model ?? "unknown",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: `Hello from mock LiteLLM (${body.model}).` },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
      })
    }

    return new Response("Not found", { status: 404 })
  },
})

console.log(`Mock LiteLLM listening on http://127.0.0.1:${server.port}`)
