import { describe, expect, test } from "bun:test"
import { pluginVersion } from "../src/config/version"

describe("pluginVersion", () => {
  test("returns the package version (not unknown)", () => {
    const version = pluginVersion()
    expect(version).not.toBe("unknown")
    expect(version).toMatch(/^\d+\.\d+\.\d+/)
  })

  test("is memoized (returns the same value on repeat calls)", () => {
    expect(pluginVersion()).toBe(pluginVersion())
  })
})
