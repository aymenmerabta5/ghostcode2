import { describe, test, expect } from "bun:test"
import { __test_generateSSEFromParts, __test_generateNonStreamContent } from "../../src/server/routes/anthropic"

function parseSSE(sse: string[]) {
  const events: Array<{ event: string; data: any; raw: string }> = []
  for (const line of sse) {
    const eventMatch = line.match(/event:\s*(\S+)/)
    const dataMatch = line.match(/data:\s*(\{.*\})/)
    if (!eventMatch || !dataMatch) continue
    try {
      const data = JSON.parse(dataMatch[1]!)
      events.push({ event: eventMatch[1]!, data, raw: line })
    } catch {
      events.push({ event: eventMatch[1]!, data: null, raw: line })
    }
  }
  return events
}

describe("anthropic parallel reopen defect - real handler logic", () => {
  test("interleaved parallel tool calls must NOT produce duplicate tool_use id at different indices (I1, I5) - FAILS before fix", () => {
    // Simulate interleaved fullStream: start tool1, start tool2, delta tool1, delta tool2, end tool1, end tool2
    // This is what AI SDK emits for parallel tools from OpenAI provider
    const parts = [
      { type: "tool-input-start", id: "toolu_1", toolName: "read_file" },
      { type: "tool-input-start", id: "toolu_2", toolName: "grep" },
      { type: "tool-input-delta", id: "toolu_1", delta: '{"path": "/foo.txt"' },
      { type: "tool-input-delta", id: "toolu_2", delta: '{"pattern": "TODO"' },
      { type: "tool-input-delta", id: "toolu_1", delta: '}' },
      { type: "tool-input-delta", id: "toolu_2", delta: '}' },
      { type: "tool-input-end", id: "toolu_1" },
      { type: "tool-input-end", id: "toolu_2" },
      { type: "finish", finishReason: "tool-calls" },
    ]

    const sse = __test_generateSSEFromParts(parts)
    const events = parseSSE(sse)

    const starts = events.filter((e) => e.event === "content_block_start")
    const toolStarts = starts.filter((e) => e.data.content_block?.type === "tool_use")

    // Check I5: tool_use ids must be unique
    const ids = toolStarts.map((s) => s.data.content_block.id)
    const uniqueIds = new Set(ids)

    // Before fix: reopen path will cause toolu_1 to appear twice at different indices
    // e.g., index 0 for toolu_1, index 1 for toolu_2, then reopen toolu_1 at index 2
    // So ids = ["toolu_1", "toolu_2", "toolu_1"] -> unique size 2 but length 3 -> violation
    // This test EXPECTS unique ids (correct behavior), so it will FAIL before fix
    expect(uniqueIds.size).toBe(ids.length)

    // Also check I1: each start must have exactly one stop with same index, and no duplicate index
    const stops = events.filter((e) => e.event === "content_block_stop")
    const startIndices = starts.map((s) => s.data.index)
    const stopIndices = stops.map((s) => s.data.index)
    const uniqueStartIndices = new Set(startIndices)
    expect(uniqueStartIndices.size).toBe(startIndices.length)
    for (const idx of startIndices) {
      const matching = stopIndices.filter((i) => i === idx)
      expect(matching.length).toBe(1)
    }

    // Should have exactly 2 tool_use blocks, not 3
    expect(toolStarts.length).toBe(2)
  })

  test("interleaved deltas must not cause premature close and reopen (I1)", () => {
    // More explicit interleaving that triggers the reopen: start1, delta1, start2 (closes 1 prematurely), delta1 again (should trigger reopen)
    const parts = [
      { type: "tool-input-start", id: "toolu_A", toolName: "read" },
      { type: "tool-input-delta", id: "toolu_A", delta: '{"path": "/a"}' },
      { type: "tool-input-start", id: "toolu_B", toolName: "grep" },
      // This delta for A arrives after B started, so A was already closed at index 0, B is open at index 1
      // Buggy code will reopen A at index 2
      { type: "tool-input-delta", id: "toolu_A", delta: ', "extra": 1}' },
      { type: "tool-input-delta", id: "toolu_B", delta: '{"pattern": "x"}' },
      { type: "tool-input-end", id: "toolu_A" },
      { type: "tool-input-end", id: "toolu_B" },
      { type: "finish", finishReason: "tool-calls" },
    ]

    const sse = __test_generateSSEFromParts(parts)
    const events = parseSSE(sse)
    const toolStarts = events.filter((e) => e.event === "content_block_start" && e.data.content_block?.type === "tool_use")
    const ids = toolStarts.map((s) => s.data.content_block.id)

    // Before fix, ids will contain ["toolu_A", "toolu_B", "toolu_A"] -> duplicate
    expect(new Set(ids).size).toBe(ids.length)
    expect(toolStarts.length).toBe(2)
  })

  test("non-stream with text + tool_calls must include both (I2 I5) - FAILS before fix", () => {
    // Simulate result with both text and toolCalls (model returns text + tool use)
    const result = {
      text: "I'll read the file",
      toolCalls: [{ toolCallId: "toolu_text_tool", toolName: "read_file", input: { path: "/tmp/foo.txt" } }],
      finishReason: "tool-calls",
    }

    const out = __test_generateNonStreamContent(result)

    // I2: stop_reason must be tool_use iff tool_use blocks present
    // Had tool call, so stop_reason should be tool_use
    expect(out.stopReason).toBe("tool_use")
    // And content must contain tool_use block when stop_reason is tool_use
    const hasToolUse = out.content.some((c: any) => c.type === "tool_use")
    const hasText = out.content.some((c: any) => c.type === "text")

    // Before fix, content only has text, dropping tool_use -> violates I2
    // This test expects both text and tool_use present when both were in upstream
    expect(hasToolUse).toBeTrue()
    // If we have both upstream, we should preserve both
    expect(hasText).toBeTrue()
    expect(out.content.length).toBe(2)
  })
})
