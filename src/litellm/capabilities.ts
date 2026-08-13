import type { LiteLLMModelGroup } from "../types"

/**
 * Convert LiteLLM capability metadata into opencode Model capabilities.
 *
 * Rules:
 * - Only declare a capability when there is reasonable evidence.
 * - When no metadata is available, use the conservative default that matches
 *   opencode's own unknown-model defaults: text in/out, tool calling and
 *   temperature for chat models. Vision / reasoning / audio / pdf are never
 *   assumed.
 */

/** Modes that can be used for chat completions through the proxy. */
const CHAT_MODES = new Set(["", "chat", "chat-completion", "completion", "responses", "chat_completion"])

/** Non-chat modes we should not expose in the model picker. */
const NON_CHAT_MODES = new Set([
  "embedding",
  "embeddings",
  "image_generation",
  "image-generation",
  "audio_transcription",
  "audio-speech",
  "audio_speech",
  "rerank",
  "reranking",
  "moderation",
  "text_completion",
  "real_time",
])

export type Capabilities = {
  temperature: boolean
  reasoning: boolean
  attachment: boolean
  toolcall: boolean
  input: { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean }
  output: { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean }
  interleaved: boolean | { field: string }
}

export type Limits = {
  context: number
  input?: number
  output: number
}

export type Costs = {
  input: number
  output: number
  cache: { read: number; write: number }
}

const DEFAULT_CONTEXT = 128_000
const DEFAULT_OUTPUT = 8_192

/** Is this mode suitable for chat? `undefined`/empty is treated as unknown => chat. */
export function isChatMode(mode: string | undefined): boolean {
  const value = (mode ?? "").trim().toLowerCase()
  if (value === "") return true
  if (CHAT_MODES.has(value)) return true
  if (NON_CHAT_MODES.has(value)) return false
  return true
}

export function buildCapabilities(meta: LiteLLMModelGroup | undefined): Capabilities {
  if (!meta) {
    return {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    }
  }

  const vision = Boolean(meta.supports_vision)
  const pdf = Boolean(meta.supports_pdf_input)
  const audioIn = Boolean(meta.supports_audio_input)
  const audioOut = Boolean(meta.supports_audio_output)
  const attachment = vision || pdf || audioIn

  return {
    temperature: meta.supports_temperature ?? true,
    reasoning: Boolean(meta.supports_reasoning),
    attachment,
    toolcall: meta.supports_function_calling ?? true,
    input: {
      text: true,
      audio: audioIn,
      image: vision,
      video: false,
      pdf,
    },
    output: {
      text: true,
      audio: audioOut,
      image: false,
      video: false,
      pdf: false,
    },
    interleaved: false,
  }
}

export function buildLimits(meta: LiteLLMModelGroup | undefined): Limits {
  if (!meta) {
    return { context: DEFAULT_CONTEXT, output: DEFAULT_OUTPUT }
  }
  const context = positiveInt(meta.max_input_tokens) ?? positiveInt(meta.max_tokens) ?? DEFAULT_CONTEXT
  const output = positiveInt(meta.max_output_tokens) ?? DEFAULT_OUTPUT
  return {
    context,
    input: positiveInt(meta.max_input_tokens),
    output,
  }
}

export function buildCosts(meta: LiteLLMModelGroup | undefined): Costs {
  if (!meta) return { input: 0, output: 0, cache: { read: 0, write: 0 } }
  return {
    input: positiveFloat(meta.input_cost_per_token) ?? 0,
    output: positiveFloat(meta.output_cost_per_token) ?? 0,
    cache: {
      read: positiveFloat(meta.cache_read_input_token_cost) ?? 0,
      write: positiveFloat(meta.cache_write_input_token_cost) ?? 0,
    },
  }
}

function positiveInt(value: number | undefined | null): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

function positiveFloat(value: number | undefined | null): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}
