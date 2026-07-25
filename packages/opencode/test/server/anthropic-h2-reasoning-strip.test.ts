import { describe, test, expect } from "bun:test"
import { __test_toModelMessages } from "../../src/server/routes/anthropic"

describe("H2: Prior reasoning without resumable state should be stripped", () => {
  test("turn 3 history: reasoning only in final assistant turn, zero in earlier", () => {
    // Simulate 3-turn session where assistant emitted reasoning summaries (no signatures) — Meta-style
    const history = [
      { role: "user", content: [{ type: "text", text: "Task 1" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "First turn thinking summary that is large", signature: "" },
          { type: "text", text: "I'll do task 1" },
          { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "/a" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "result 1" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Second turn thinking summary", signature: "" },
          { type: "text", text: "Second response" },
          { type: "tool_use", id: "toolu_2", name: "read_file", input: { path: "/b" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "result 2" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Final turn thinking - should be kept", signature: "" },
          { type: "text", text: "Final answer" },
        ],
      },
    ]

    const core = __test_toModelMessages(history as any)

    // Count reasoning bytes per assistant turn
    const assistantMessages = core.filter((m: any) => m.role === "assistant")
    expect(assistantMessages.length).toBe(3)

    const reasoningBytes = assistantMessages.map((m: any) => {
      const content = Array.isArray(m.content) ? m.content : []
      return content.filter((p: any) => p.type === "reasoning").reduce((sum: number, p: any) => sum + (p.text?.length ?? 0), 0)
    })

    // H2 fix: earlier turns should have 0 reasoning bytes (stripped), final should have >0
    expect(reasoningBytes[0]).toBe(0)
    expect(reasoningBytes[1]).toBe(0)
    expect(reasoningBytes[2]).toBeGreaterThan(0)
  })

  test("Anthropic thinking with signatures should be preserved in earlier turns", () => {
    const history = [
      { role: "user", content: [{ type: "text", text: "Task" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "First thinking with sig", signature: "sig_abc123" },
          { type: "text", text: "First" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "Continue" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Second with sig", signature: "sig_def456" },
          { type: "text", text: "Second" },
        ],
      },
    ]

    const core = __test_toModelMessages(history as any)
    const assistants = core.filter((m: any) => m.role === "assistant")
    expect(assistants.length).toBe(2)

    // For Anthropic with signatures, we SHOULD preserve earlier reasoning
    const firstReasoning = assistants[0]!.content.filter((p: any) => p.type === "reasoning")
    expect(firstReasoning.length).toBe(1)
    expect(firstReasoning[0]!.text).toBe("First thinking with sig")
    expect(firstReasoning[0]!.providerOptions?.anthropic?.signature).toBe("sig_abc123")
  })

  test("redacted thinking with data should be preserved", () => {
    const history = [
      {
        role: "assistant",
        content: [{ type: "redacted_thinking", data: "redacted_data_here" }],
      },
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "final" }],
      },
    ]

    const core = __test_toModelMessages(history as any)
    const assistants = core.filter((m: any) => m.role === "assistant")
    // First assistant has redacted thinking with data -> should be preserved (has resumable state)
    const first = assistants[0]!
    const reasoning = first.content.filter((p: any) => p.type === "reasoning")
    expect(reasoning.length).toBe(1)
  })
})
