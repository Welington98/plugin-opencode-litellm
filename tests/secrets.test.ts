import { describe, expect, test } from "bun:test"
import { maskSecret, looksLikeApiKey, redactError, safeErrorMessage } from "../src/security/secrets"

describe("maskSecret", () => {
  test("masks the middle of a long key", () => {
    expect(maskSecret("sk-1234567890abcdef")).toBe("sk-************cdef")
  })

  test("short keys still mask without growing", () => {
    expect(maskSecret("sk-12345").length).toBe("sk-12345".length)
    expect(maskSecret("sk-12345")).toBe("sk-*****")
  })

  test("empty / null input returns empty", () => {
    expect(maskSecret("")).toBe("")
    expect(maskSecret(undefined)).toBe("")
    expect(maskSecret(null)).toBe("")
  })

  test("never contains more than the original", () => {
    const key = "sk-1234567890abcdef"
    const masked = maskSecret(key)
    expect(masked).not.toContain(key.slice(3, -4))
    expect(masked.length).toBeGreaterThan(0)
  })
})

describe("looksLikeApiKey", () => {
  test("recognizes sk- prefixed keys", () => {
    expect(looksLikeApiKey("sk-abcdef123456")).toBe(true)
  })

  test("rejects random text", () => {
    expect(looksLikeApiKey("hello world")).toBe(false)
    expect(looksLikeApiKey("")).toBe(false)
    expect(looksLikeApiKey(undefined)).toBe(false)
  })
})

describe("redactError", () => {
  test("replaces the secret occurrence", () => {
    const message = "Auth failed for sk-1234567890abcdef again"
    expect(redactError(message, ["sk-1234567890abcdef"])).toBe("Auth failed for [REDACTED] again")
  })

  test("leaves short secrets untouched to avoid noise", () => {
    expect(redactError("abc", ["ab"])).toBe("abc")
  })
})

describe("safeErrorMessage", () => {
  test("strips the key from Error messages", () => {
    const err = new Error("Request failed with sk-super-secret-token-123")
    expect(safeErrorMessage(err, ["sk-super-secret-token-123"])).toBe("Request failed with [REDACTED]")
  })

  test("handles non-Error throws", () => {
    expect(safeErrorMessage("boom", ["x"])).toBe("boom")
  })
})
