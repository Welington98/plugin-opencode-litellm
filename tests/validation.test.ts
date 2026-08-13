import { describe, expect, test } from "bun:test"
import { litellmBaseURL, normalizeEndpoint, validateApiKey, validateEndpoint } from "../src/config/validation"

describe("validateEndpoint", () => {
  test("accepts https endpoint and strips trailing slashes", () => {
    const result = validateEndpoint("https://litellm.example.com/")
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe("https://litellm.example.com")
  })

  test("accepts http endpoint", () => {
    const result = validateEndpoint("http://localhost:4000")
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe("http://localhost:4000")
  })

  test("rejects empty input", () => {
    expect(validateEndpoint("").ok).toBe(false)
  })

  test("rejects non-URL text", () => {
    expect(validateEndpoint("not a url").ok).toBe(false)
  })

  test("rejects unsupported protocols", () => {
    expect(validateEndpoint("ftp://example.com").ok).toBe(false)
    expect(validateEndpoint("file:///tmp").ok).toBe(false)
  })

  test("rejects missing host", () => {
    expect(validateEndpoint("https://").ok).toBe(false)
  })
})

describe("normalizeEndpoint", () => {
  test("removes trailing slashes and trims whitespace", () => {
    expect(normalizeEndpoint("  https://litellm.example.com////  ")).toBe("https://litellm.example.com")
  })
})

describe("validateApiKey", () => {
  test("accepts a reasonable key", () => {
    expect(validateApiKey("sk-12345678").ok).toBe(true)
  })

  test("rejects empty / short keys", () => {
    expect(validateApiKey("").ok).toBe(false)
    expect(validateApiKey("short").ok).toBe(false)
  })
})

describe("litellmBaseURL", () => {
  test("appends /v1", () => {
    expect(litellmBaseURL("https://litellm.example.com")).toBe("https://litellm.example.com/v1")
  })
})
