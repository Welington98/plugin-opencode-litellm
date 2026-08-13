import { describe, expect, test } from "bun:test"
import { buildCapabilities, buildCosts, buildLimits, isChatMode } from "../src/litellm/capabilities"
import type { LiteLLMModelGroup } from "../src/types"

const visionModel: LiteLLMModelGroup = {
  model_group: "gpt-4o",
  mode: "chat",
  supports_vision: true,
  supports_function_calling: true,
  supports_temperature: true,
  supports_reasoning: false,
  supports_pdf_input: true,
  max_input_tokens: 128000,
  max_output_tokens: 4096,
  input_cost_per_token: 0.000005,
  output_cost_per_token: 0.000015,
  cache_read_input_token_cost: 0.000002,
}

describe("buildCapabilities", () => {
  test("maps vision + tools + temperature from metadata", () => {
    const caps = buildCapabilities(visionModel)
    expect(caps.input.image).toBe(true)
    expect(caps.input.pdf).toBe(true)
    expect(caps.attachment).toBe(true)
    expect(caps.toolcall).toBe(true)
    expect(caps.temperature).toBe(true)
    expect(caps.reasoning).toBe(false)
    expect(caps.output.audio).toBe(false)
  })

  test("never claims vision without evidence", () => {
    const caps = buildCapabilities(undefined)
    expect(caps.input.image).toBe(false)
    expect(caps.input.audio).toBe(false)
    expect(caps.input.pdf).toBe(false)
    expect(caps.attachment).toBe(false)
    expect(caps.reasoning).toBe(false)
  })

  test("conservative fallback keeps text + tools + temperature for chat", () => {
    const caps = buildCapabilities(undefined)
    expect(caps.input.text).toBe(true)
    expect(caps.output.text).toBe(true)
    expect(caps.toolcall).toBe(true)
    expect(caps.temperature).toBe(true)
  })

  test("audio inputs are mapped when declared", () => {
    const caps = buildCapabilities({ ...visionModel, supports_audio_input: true, supports_audio_output: true })
    expect(caps.input.audio).toBe(true)
    expect(caps.output.audio).toBe(true)
    expect(caps.attachment).toBe(true)
  })
})

describe("buildLimits", () => {
  test("uses metadata limits", () => {
    const limits = buildLimits(visionModel)
    expect(limits.context).toBe(128000)
    expect(limits.output).toBe(4096)
    expect(limits.input).toBe(128000)
  })

  test("fallback defaults", () => {
    const limits = buildLimits(undefined)
    expect(limits.context).toBe(128000)
    expect(limits.output).toBe(8192)
  })
})

describe("buildCosts", () => {
  test("maps per-token costs", () => {
    const costs = buildCosts(visionModel)
    expect(costs.input).toBe(0.000005)
    expect(costs.output).toBe(0.000015)
    expect(costs.cache.read).toBe(0.000002)
  })

  test("zeroes out when absent", () => {
    expect(buildCosts(undefined)).toEqual({ input: 0, output: 0, cache: { read: 0, write: 0 } })
  })
})

describe("isChatMode", () => {
  test("accepts chat modes and unknown modes", () => {
    expect(isChatMode("chat")).toBe(true)
    expect(isChatMode("completion")).toBe(true)
    expect(isChatMode(undefined)).toBe(true)
    expect(isChatMode("chat-completion")).toBe(true)
  })

  test("excludes embedding and image generation", () => {
    expect(isChatMode("embedding")).toBe(false)
    expect(isChatMode("image_generation")).toBe(false)
    expect(isChatMode("rerank")).toBe(false)
  })
})
