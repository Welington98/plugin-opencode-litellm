import { describe, expect, test } from "bun:test"
import plugin from "../src/server"

describe("OpenCode V2 server entrypoint", () => {
  test("exports a definition accepted by the V2 loader", () => {
    expect(plugin.id).toBe("welington98.opencode-litellm")
    expect(typeof plugin.setup).toBe("function")
  })
})
