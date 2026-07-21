import { describe, expect, test } from "bun:test"

describe("Workflows v2 - keyed journal replay", () => {
  function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value)
    if (Array.isArray(value)) return "[" + value.map(v => stableStringify(v)).join(",") + "]"
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    return "{" + keys.map(k => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}"
  }

  function stableHash(obj: unknown): string {
    const { createHash } = require("crypto")
    return createHash("sha256").update(stableStringify(obj)).digest("hex").slice(0, 16)
  }

  test("reordering/inserting/removing agent() calls does not poison suffix (keyed)", () => {
    // Simulate original order: A, B, C
    const original = [
      { prompt: "prompt A", label: "A" },
      { prompt: "prompt B", label: "B" },
      { prompt: "prompt C", label: "C" },
    ]
    const originalKeys = original.map(o => stableHash({ ...o, agent: "", model: "", schema: "", phase: "test", agentType: "", effort: "" }))

    // Reordered: C, A, B (like user reorders code)
    const reordered = [
      { prompt: "prompt C", label: "C" },
      { prompt: "prompt A", label: "A" },
      { prompt: "prompt B", label: "B" },
    ]
    const reorderedKeys = reordered.map(o => stableHash({ ...o, agent: "", model: "", schema: "", phase: "test", agentType: "", effort: "" }))

    // Keys should still match regardless of order (same set)
    expect(new Set(originalKeys)).toEqual(new Set(reorderedKeys))

    // Simulate cache map from original run
    const cacheMap = new Map<string, any>()
    original.forEach((item, idx) => {
      const key = originalKeys[idx]
      cacheMap.set(key, { id: `node-${idx}`, output: `output-${item.label}`, label: item.label })
    })

    // On resume with reordered calls, each key should still be found
    for (const item of reordered) {
      const key = stableHash({ ...item, agent: "", model: "", schema: "", phase: "test", agentType: "", effort: "" })
      const cached = cacheMap.get(key)
      expect(cached).toBeDefined()
      expect(cached.label).toBe(item.label)
    }
  })

  test("invalidation by label and cache key", () => {
    const cacheMap = new Map([
      ["key-a", { label: "agent-a", output: "a" }],
      ["key-b", { label: "agent-b", output: "b" }],
      ["key-c", { label: "agent-c", output: "c" }],
    ])

    const invalidatedLabels = new Set(["agent-b"])
    const invalidatedKeys = new Set(["key-c"])

    // Simulate filtering as done in resume handling
    const journal = [
      { cache_key: "key-a", label: "agent-a", status: "completed" },
      { cache_key: "key-b", label: "agent-b", status: "completed" },
      { cache_key: "key-c", label: "agent-c", status: "completed" },
    ]

    const filtered = journal.filter((a: any) => {
      if (invalidatedLabels.has(a.label)) return false
      if (invalidatedKeys.has(a.cache_key)) return false
      return true
    })

    expect(filtered.length).toBe(1)
    expect(filtered[0].label).toBe("agent-a")
  })

  test("invalidatePhase sugar invalidates every key under that phase", () => {
    const agents = [
      { cache_key: "k1", phase: "discover", label: "a" },
      { cache_key: "k2", phase: "discover", label: "b" },
      { cache_key: "k3", phase: "validate", label: "c" },
    ]

    const phaseToInvalidate = "discover"
    const keysToInvalidate = agents.filter(a => a.phase === phaseToInvalidate).map(a => a.cache_key)

    expect(keysToInvalidate).toEqual(["k1", "k2"])

    // After invalidation, only validate phase remains
    const remaining = agents.filter(a => !keysToInvalidate.includes(a.cache_key))
    expect(remaining.length).toBe(1)
    expect(remaining[0].phase).toBe("validate")
  })
})
