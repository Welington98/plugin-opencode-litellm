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

/**
 * Modes that can be used for chat completions through the proxy.
 *
 * These mirror LiteLLM's `ModelInfoBase.mode` literal where a value is chat
 * capable. Note `completion` is NOT chat — it is base text completion (e.g.
 * `davinci-002`, `gpt-3.5-turbo-instruct`) and must be filtered out.
 */
const CHAT_MODES = new Set(["", "chat", "chat-completion", "chat_completion", "responses"])

/**
 * Non-chat modes we should not expose in the model picker.
 *
 * Covers LiteLLM's real `mode` values (`completion`, `embedding`,
 * `image_generation`, `audio_transcription`, `ocr`, `realtime`, ...) plus a
 * few historical/legacy spellings that have shown up in proxies.
 */
const NON_CHAT_MODES = new Set([
  "completion",
  "text_completion",
  "embedding",
  "embeddings",
  "image_generation",
  "image-generation",
  "audio_transcription",
  "audio_speech",
  "audio-speech",
  "speech",
  "rerank",
  "reranking",
  "moderation",
  "ocr",
  "realtime",
  "real_time",
])

/**
 * Id patterns that identify non-chat models when no authoritative `mode`
 * metadata is available (metadata endpoint down, or the model id does not
 * match any `model_group` key). `/v1/models` returns the full proxy model
 * list, so without this the picker would surface embeddings, image/audio/video
 * generation, transcription, moderation and base-completion models as chat.
 */
const NON_CHAT_ID_PATTERNS: RegExp[] = [
  /\bembedding(s)?\b/i,
  /\bdall[-_]?e\b/i,
  /\bimage\b/i,
  /\bwhisper\b/i,
  /\btranscrib(e|ing|ption)\b/i,
  /\btts\b/i,
  /\bspeech\b/i,
  /\bmoderation\b/i,
  /\bsora\b/i,
  /\brealtime\b/i,
  /\brerank(ing)?\b/i,
  /\binstruct\b/i,
  /\b(babbage|davinci)\b/i,
  /\baudio\b/i,
]

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

/** True when a model id carries an obvious non-chat marker (no mode available). */
export function looksNonChatModel(id: string): boolean {
  const value = id.trim().toLowerCase()
  if (value.startsWith("ft:")) return true
  return NON_CHAT_ID_PATTERNS.some((re) => re.test(value))
}

/**
 * Decide whether a discovered model id should be exposed as a chat model.
 *
 * Priority:
 *   1. authoritative `mode` metadata (chat/responses => keep; others => drop)
 *   2. unknown/missing mode => conservative name heuristic
 */
export function isChatModel(id: string, meta: LiteLLMModelGroup | undefined): boolean {
  const mode = (meta?.mode ?? "").trim().toLowerCase()
  if (mode !== "" && CHAT_MODES.has(mode)) return true
  if (mode !== "" && NON_CHAT_MODES.has(mode)) return false
  return !looksNonChatModel(id)
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
