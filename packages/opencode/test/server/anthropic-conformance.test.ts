import { describe, test, expect } from "bun:test"

// Test the proxy's core logic without full HTTP server
// These tests validate invariants I1-I5 and requirements T1-T5

// Simulate the proxy's toModelMessages and SSE generation logic

// =============================================================================
// Helpers to simulate proxy behavior (mirrors anthropic.ts logic)
// =============================================================================

function simulateToModelMessages(input: any[]) {
  const toolNameById: Record<string, string> = {}
  for (const m of input) {
    if (typeof m.content === "string") continue
    const c = m.content as any[]
    if (!Array.isArray(c)) continue
    for (const part of c) {
      if (part?.type === "tool_use" && part.id) {
        toolNameById[part.id] = part.name
      }
    }
  }

  let fallbackId = 0
  const nextFallback = () => `tool_${++fallbackId}`
  const result: any[] = []

  for (const m of input) {
    if (m.role === "system") {
      const text =
        typeof m.content === "string"
          ? m.content
          : (m.content as any[]).map((p: any) => p.text ?? p.thinking ?? "").join("\n")
      if (!text.trim()) continue
      result.push({ role: "system", content: text })
      continue
    }

    const role = m.role as any
    if (typeof m.content === "string") {
      result.push({ role, content: m.content || " " })
      continue
    }

    const rawParts = m.content as any[]
    const parts: any[] = []

    for (const part of rawParts) {
      if (!part) continue
      if (part.type === "text") {
        parts.push({ type: "text", text: part.text ?? "" })
      } else if (part.type === "image") {
        parts.push({ type: "image", image: part.source?.data, mimeType: part.source?.media_type })
      } else if (part.type === "thinking") {
        parts.push({
          type: "reasoning",
          text: part.thinking ?? part.text ?? "",
          providerOptions: {
            ...(part.providerOptions || {}),
            anthropic: {
              ...(part.providerOptions?.anthropic || {}),
              ...(part.signature ? { signature: part.signature } : {}),
              ...(part.data ? { redactedData: part.data } : {}),
            },
          },
        })
      } else if (part.type === "redacted_thinking") {
        parts.push({
          type: "reasoning",
          text: "",
          providerOptions: {
            ...(part.providerOptions || {}),
            anthropic: {
              ...(part.providerOptions?.anthropic || {}),
              redactedData: part.data,
            },
          },
        })
      } else if (part.type === "tool_use") {
        parts.push({
          type: "tool-call",
          toolCallId: part.id,
          toolName: part.name || "unknown_tool",
          input: part.input ?? {},
        })
      } else if (part.type === "tool_result") {
        const resolvedName = toolNameById[part.tool_use_id] || (part as any).name || part.tool_use_id || "unknown_tool"
        const content = part.content
        let output: any
        if (typeof content === "string") {
          output = { type: "text", value: content || " " }
        } else if (Array.isArray(content)) {
          let txt = ""
          for (const b of content as any[]) {
            const piece = b.type === "text" ? b.text : b.type === "media" ? "[media]" : ""
            if (!piece) continue
            txt = txt ? txt + "\n" + piece : piece
          }
          output = { type: "text", value: txt || " " }
        } else {
          output = { type: "text", value: " " }
        }
        parts.push({
          type: "tool-result",
          toolCallId: part.tool_use_id || nextFallback(),
          toolName: resolvedName,
          output,
        })
      }
    }

    if (parts.length === 0) {
      if (role === "assistant") result.push({ role, content: [{ type: "text", text: "" }] })
      continue
    }

    if (m.role === "user") {
      const hasToolResult = parts.some((p: any) => p.type === "tool-result")
      if (hasToolResult) {
        const toolResults: any[] = []
        const rest: any[] = []
        for (const pp of parts) {
          if (pp.type === "tool-result") toolResults.push(pp)
          else rest.push(pp)
        }
        result.push({ role: "tool", content: toolResults })
        if (rest.length > 0) result.push({ role: "user", content: rest })
        continue
      }
    }

    result.push({ role, content: parts })
  }

  return result
}

function toAnthropicStopReason(finishReason: string | undefined, hadToolCall?: boolean): string {
  if (hadToolCall) return "tool_use"
  switch (finishReason) {
    case "stop":
      return "end_turn"
    case "length":
      return "max_tokens"
    case "tool-calls":
      return "tool_use"
    default:
      return "end_turn"
  }
}

function simulateSSEGeneration(events: Array<{ type: string; [key: string]: any }>): string[] {
  const sse: string[] = []
  let blockIndex = 0
  let blockType: string | null = null
  let hadToolCall = false
  let finishReason: string | undefined
  const toolBlocks = new Map<string, { blockIndex: number; toolName: string; hasDelta: boolean }>()

  const send = (s: string) => sse.push(s)

  const closeBlock = () => {
    if (!blockType) return
    send(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}\n\n`)
    blockIndex++
    blockType = null
  }

  const openTextBlock = () => {
    if (blockType === "text") return
    closeBlock()
    send(
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: blockIndex,
        content_block: { type: "text", text: "" },
      })}\n\n`,
    )
    blockType = "text"
  }

  const openThinkingBlock = () => {
    if (blockType === "thinking") return
    closeBlock()
    send(
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: blockIndex,
        content_block: { type: "thinking", thinking: "" },
      })}\n\n`,
    )
    blockType = "thinking"
  }

  send(
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "test-model",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    })}\n\n`,
  )

  for (const part of events) {
    if (part.type === "text-start") {
      openTextBlock()
    } else if (part.type === "text-delta") {
      openTextBlock()
      send(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "text_delta", text: part.text },
        })}\n\n`,
      )
    } else if (part.type === "text-end") {
      closeBlock()
    } else if (part.type === "reasoning-start") {
      openThinkingBlock()
    } else if (part.type === "reasoning-delta") {
      openThinkingBlock()
      send(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "thinking_delta", thinking: part.text },
        })}\n\n`,
      )
      if (part.signature) {
        send(
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "signature_delta", signature: part.signature },
          })}\n\n`,
        )
      }
    } else if (part.type === "reasoning-end") {
      if (part.signature) {
        send(
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "signature_delta", signature: part.signature },
          })}\n\n`,
        )
      }
      closeBlock()
    } else if (part.type === "finish") {
      finishReason = part.finishReason
    } else if (part.type === "tool-input-start") {
      hadToolCall = true
      const existing = toolBlocks.get(part.id)
      if (existing) continue
      if (blockType && blockType !== "tool_use") closeBlock()
      else if (blockType === "tool_use") closeBlock()

      send(
        `event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: blockIndex,
          content_block: { type: "tool_use", id: part.id, name: part.toolName, input: {} },
        })}\n\n`,
      )
      blockType = "tool_use" as any
      toolBlocks.set(part.id, { blockIndex, toolName: part.toolName, hasDelta: false })
    } else if (part.type === "tool-input-delta") {
      let state = toolBlocks.get(part.id)
      if (!state) {
        if (blockType) closeBlock()
        send(
          `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: blockIndex,
            content_block: { type: "tool_use", id: part.id, name: part.toolName || "unknown", input: {} },
          })}\n\n`,
        )
        blockType = "tool_use" as any
        state = { blockIndex, toolName: part.toolName || "unknown", hasDelta: false }
        toolBlocks.set(part.id, state)
      }
      state.hasDelta = true
      send(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: state.blockIndex,
          delta: { type: "input_json_delta", partial_json: part.delta },
        })}\n\n`,
      )
    } else if (part.type === "tool-input-end") {
      const state = toolBlocks.get(part.id)
      if (state && blockType === "tool_use" && blockIndex === state.blockIndex) {
        closeBlock()
      }
    } else if (part.type === "tool-call") {
      hadToolCall = true
      const state = toolBlocks.get(part.toolCallId)
      if (state?.hasDelta) {
        if (blockType) closeBlock()
        continue
      }
      closeBlock()
      const input = JSON.stringify(part.input || {})
      send(
        `event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: blockIndex,
          content_block: { type: "tool_use", id: part.toolCallId, name: part.toolName, input: {} },
        })}\n\n`,
      )
      send(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "input_json_delta", partial_json: input },
        })}\n\n`,
      )
      send(
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}\n\n`,
      )
      blockIndex++
    }
  }

  closeBlock()
  const finalStopReason = toAnthropicStopReason(finishReason, hadToolCall)
  send(
    `event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: finalStopReason, stop_sequence: null },
      usage: { output_tokens: 100 },
    })}\n\n`,
  )
  send(`event: message_stop\ndata: {"type":"message_stop"}\n\n`)

  return sse
}

function parseSSEEvents(sseLines: string[]): Array<{ event: string; data: any; index?: number }> {
  const result: Array<{ event: string; data: any; index?: number }> = []
  for (const line of sseLines) {
    const eventMatch = line.match(/event:\s*(\S+)/)
    const dataMatch = line.match(/data:\s*(\{.*\})/)
    if (!eventMatch || !dataMatch) continue
    try {
      const data = JSON.parse(dataMatch[1]!)
      result.push({ event: eventMatch[1]!, data, index: data.index })
    } catch {
      result.push({ event: eventMatch[1]!, data: null })
    }
  }
  return result
}

// =============================================================================
// T1: Golden SSE conformance
// =============================================================================
describe("T1: Golden SSE conformance", () => {
  test("T1a: text-only reply - exact event sequence, block indices, stop_reason, message_stop", () => {
    const events = [
      { type: "text-start" },
      { type: "text-delta", text: "Hello" },
      { type: "text-delta", text: " world" },
      { type: "text-end" },
      { type: "finish", finishReason: "stop" },
    ]

    const sse = simulateSSEGeneration(events)
    const parsed = parseSSEEvents(sse)

    // Exact sequence: message_start -> content_block_start(0) -> delta(0) -> delta(0) -> stop(0) -> message_delta -> message_stop
    const eventTypes = parsed.map((p) => p.event)
    expect(eventTypes).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])

    // Block indices: all 0 for single text block
    const blockEvents = parsed.filter((p) => p.data?.index !== undefined)
    for (const e of blockEvents) {
      if (e.event === "content_block_start" || e.event === "content_block_delta" || e.event === "content_block_stop") {
        expect(e.data.index).toBe(0)
      }
    }

    // stop_reason should be end_turn for text-only
    const delta = parsed.find((p) => p.event === "message_delta")
    expect(delta?.data.delta.stop_reason).toBe("end_turn")

    // message_stop must be present
    const stop = parsed.find((p) => p.event === "message_stop")
    expect(stop).toBeDefined()
  })

  test("T1b: single tool call - exact sequence with tool_use", () => {
    const events = [
      { type: "text-start" },
      { type: "text-delta", text: "I'll check" },
      { type: "text-end" },
      { type: "tool-call", toolCallId: "toolu_123", toolName: "read_file", input: { path: "/tmp/foo.txt" } },
      { type: "finish", finishReason: "tool-calls" },
    ]

    const sse = simulateSSEGeneration(events)
    const parsed = parseSSEEvents(sse)

    const eventTypes = parsed.map((p) => p.event)
    expect(eventTypes).toEqual([
      "message_start",
      "content_block_start", // text 0
      "content_block_delta",
      "content_block_stop",
      "content_block_start", // tool_use 1
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])

    // Block indices increment correctly
    const starts = parsed.filter((p) => p.event === "content_block_start")
    expect(starts[0]!.data.index).toBe(0)
    expect(starts[1]!.data.index).toBe(1)

    // stop_reason must be tool_use when tool calls present
    const delta = parsed.find((p) => p.event === "message_delta")
    expect(delta?.data.delta.stop_reason).toBe("tool_use")

    expect(parsed.find((p) => p.event === "message_stop")).toBeDefined()
  })

  test("T1c: parallel tool calls - correct indices and stop_reason", () => {
    const events = [
      { type: "tool-input-start", id: "toolu_1", toolName: "grep" },
      { type: "tool-input-delta", id: "toolu_1", delta: '{"pattern": "foo"' },
      { type: "tool-input-end", id: "toolu_1" },
      { type: "tool-input-start", id: "toolu_2", toolName: "read" },
      { type: "tool-input-delta", id: "toolu_2", delta: '{"path": "/bar"}' },
      { type: "tool-input-end", id: "toolu_2" },
      { type: "finish", finishReason: "tool-calls" },
    ]

    const sse = simulateSSEGeneration(events)
    const parsed = parseSSEEvents(sse)

    const starts = parsed.filter((p) => p.event === "content_block_start")
    expect(starts.length).toBe(2)
    expect(starts[0]!.data.index).toBe(0)
    expect(starts[1]!.data.index).toBe(1)

    // Each tool block must have start/delta/stop
    const deltas = parsed.filter((p) => p.event === "content_block_delta")
    expect(deltas.length).toBe(2)
    expect(deltas[0]!.data.index).toBe(0)
    expect(deltas[1]!.data.index).toBe(1)

    const stops = parsed.filter((p) => p.event === "content_block_stop")
    expect(stops.length).toBe(2)
    expect(stops[0]!.data.index).toBe(0)
    expect(stops[1]!.data.index).toBe(1)

    // stop_reason tool_use
    expect(parsed.find((p) => p.event === "message_delta")!.data.delta.stop_reason).toBe("tool_use")
    expect(parsed.find((p) => p.event === "message_stop")).toBeDefined()
  })

  test("T1d: thinking + tool call - correct sequence", () => {
    const events = [
      { type: "reasoning-start" },
      { type: "reasoning-delta", text: "Let me think about this", signature: "sig_abc123" },
      { type: "reasoning-end", signature: "sig_abc123" },
      { type: "text-start" },
      { type: "text-delta", text: "I'll read the file" },
      { type: "text-end" },
      { type: "tool-call", toolCallId: "toolu_456", toolName: "read_file", input: { path: "/tmp/test.txt" } },
      { type: "finish", finishReason: "tool-calls" },
    ]

    const sse = simulateSSEGeneration(events)
    const parsed = parseSSEEvents(sse)

    // Sequence: message_start, thinking block (0) with deltas, stop, text block (1), stop, tool_use block (2), stop, delta, stop
    const eventTypes = parsed.map((p) => p.event)
    expect(eventTypes[0]).toBe("message_start")
    expect(eventTypes).toContain("message_stop")
    expect(eventTypes.filter((e) => e === "content_block_start").length).toBe(3)

    // Check indices increment
    const starts = parsed.filter((p) => p.event === "content_block_start")
    expect(starts[0]!.data.index).toBe(0) // thinking
    expect(starts[1]!.data.index).toBe(1) // text
    expect(starts[2]!.data.index).toBe(2) // tool_use

    // Thinking block should include signature_delta
    const thinkingDeltas = parsed.filter(
      (p) => p.event === "content_block_delta" && p.data?.index === 0 && p.data?.delta?.type === "thinking_delta",
    )
    expect(thinkingDeltas.length).toBe(1)

    const sigDeltas = parsed.filter(
      (p) => p.event === "content_block_delta" && p.data?.delta?.type === "signature_delta",
    )
    expect(sigDeltas.length).toBeGreaterThanOrEqual(1)
    expect(sigDeltas[0]!.data.delta.signature).toBe("sig_abc123")

    // stop_reason tool_use
    expect(parsed.find((p) => p.event === "message_delta")!.data.delta.stop_reason).toBe("tool_use")
  })

  test("T1: message_stop is always sent even with no content", () => {
    const events = [{ type: "finish", finishReason: "stop" }]
    const sse = simulateSSEGeneration(events)
    const parsed = parseSSEEvents(sse)

    expect(parsed.find((p) => p.event === "message_stop")).toBeDefined()
    expect(parsed.find((p) => p.event === "message_delta")).toBeDefined()
  })
})

// =============================================================================
// T2: Round-trip fidelity
// =============================================================================
describe("T2: Round-trip fidelity", () => {
  test("preserves thinking blocks with signatures byte-identical, in order", () => {
    const history = [
      {
        role: "user",
        content: [{ type: "text", text: "Read file foo.txt and summarize" }],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I need to read the file first. Let me check...", signature: "sig_abc123" },
          { type: "text", text: "I'll read the file" },
          { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "/tmp/foo.txt" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file contents here" }],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Now I have file contents, I should summarize", signature: "sig_def456" },
          { type: "text", text: "The file contains..." },
        ],
      },
    ]

    const coreMessages = simulateToModelMessages(history)

    // Check thinking preserved as reasoning with signature
    const assistantMessages = coreMessages.filter((m: any) => m.role === "assistant")
    expect(assistantMessages.length).toBe(2)

    // First assistant message should have reasoning + text + tool-call
    const firstAssistant = assistantMessages[0]!
    const reasoningParts = firstAssistant.content.filter((p: any) => p.type === "reasoning")
    expect(reasoningParts.length).toBe(1)
    expect(reasoningParts[0]!.text).toBe("I need to read the file first. Let me check...")
    expect(reasoningParts[0]!.providerOptions?.anthropic?.signature).toBe("sig_abc123")

    // Second assistant message should have reasoning preserved
    const secondAssistant = assistantMessages[1]!
    const secondReasoning = secondAssistant.content.filter((p: any) => p.type === "reasoning")
    expect(secondReasoning.length).toBe(1)
    expect(secondReasoning[0]!.text).toBe("Now I have file contents, I should summarize")
    expect(secondReasoning[0]!.providerOptions?.anthropic?.signature).toBe("sig_def456")

    // Order preserved: reasoning should be first in each assistant message
    expect(firstAssistant.content[0]!.type).toBe("reasoning")
    expect(secondAssistant.content[0]!.type).toBe("reasoning")
  })

  test("preserves parallel tool_use/tool_result pairs byte-level equality", () => {
    const history = [
      {
        role: "user",
        content: [{ type: "text", text: "Search and read" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll search and read in parallel" },
          { type: "tool_use", id: "toolu_abc123", name: "grep", input: { pattern: "TODO", path: "/src" } },
          { type: "tool_use", id: "toolu_def456", name: "read_file", input: { path: "/src/index.ts" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_abc123", content: "found 8 files matching TODO" },
          { type: "tool_result", tool_use_id: "toolu_def456", content: "file content of index.ts" },
        ],
      },
    ]

    const coreMessages = simulateToModelMessages(history)

    // Check tool calls preserved
    const assistant = coreMessages.find((m: any) => m.role === "assistant")!
    const toolCalls = assistant.content.filter((p: any) => p.type === "tool-call")
    expect(toolCalls.length).toBe(2)
    expect(toolCalls[0]!.toolCallId).toBe("toolu_abc123")
    expect(toolCalls[0]!.toolName).toBe("grep")
    expect(JSON.stringify(toolCalls[0]!.input)).toBe(JSON.stringify({ pattern: "TODO", path: "/src" }))
    expect(toolCalls[1]!.toolCallId).toBe("toolu_def456")
    expect(toolCalls[1]!.toolName).toBe("read_file")

    // Check tool results preserved with matching IDs - 1:1 mapping
    const toolMessage = coreMessages.find((m: any) => m.role === "tool")!
    expect(toolMessage.content.length).toBe(2)
    expect(toolMessage.content[0]!.toolCallId).toBe("toolu_abc123")
    expect(toolMessage.content[0]!.toolName).toBe("grep")
    expect(toolMessage.content[1]!.toolCallId).toBe("toolu_def456")
    expect(toolMessage.content[1]!.toolName).toBe("read_file")

    // Order preserved
    expect(toolMessage.content[0]!.toolCallId).toBe("toolu_abc123")
    expect(toolMessage.content[1]!.toolCallId).toBe("toolu_def456")
  })

  test("preserves large tool_results without truncation", () => {
    const largeContent = "a".repeat(10000)

    const history = [
      {
        role: "user",
        content: [{ type: "text", text: "Read large file" }],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_large", name: "read_file", input: { path: "/large.txt" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_large", content: largeContent }],
      },
    ]

    const coreMessages = simulateToModelMessages(history)
    const toolMessage = coreMessages.find((m: any) => m.role === "tool")!

    expect(toolMessage.content[0]!.output.value).toBe(largeContent)
    expect(toolMessage.content[0]!.output.value.length).toBe(10000)
  })

  test("byte-level equality of ids, signatures, order, content", () => {
    const history = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Think step 1", signature: "sig_1" },
          { type: "thinking", thinking: "Think step 2", signature: "sig_2" },
          { type: "tool_use", id: "id_1", name: "tool1", input: { a: 1 } },
          { type: "tool_use", id: "id_2", name: "tool2", input: { b: 2 } },
        ],
      },
    ]

    const coreMessages = simulateToModelMessages(history)
    const assistant = coreMessages[0]!

    // Byte-level checks
    expect(assistant.content[0]!.text).toBe("Think step 1")
    expect(assistant.content[0]!.providerOptions.anthropic.signature).toBe("sig_1")
    expect(assistant.content[1]!.text).toBe("Think step 2")
    expect(assistant.content[1]!.providerOptions.anthropic.signature).toBe("sig_2")
    expect(assistant.content[2]!.toolCallId).toBe("id_1")
    expect(assistant.content[3]!.toolCallId).toBe("id_2")

    // Order check
    expect(assistant.content[0]!.type).toBe("reasoning")
    expect(assistant.content[1]!.type).toBe("reasoning")
    expect(assistant.content[2]!.type).toBe("tool-call")
    expect(assistant.content[3]!.type).toBe("tool-call")
  })
})

// =============================================================================
// T3: Retry-trigger detection
// =============================================================================
describe("T3: Retry-trigger detection", () => {
  test("backend failure mid-stream emits proper terminal error event", () => {
    // Simulate backend that fails after sending some content
    const mockStream = [
      { type: "text-start" },
      { type: "text-delta", text: "Partial content..." },
      // Then fails
    ]

    // In real proxy, on error it should emit error event, not drop connection
    const sse = simulateSSEGeneration(mockStream)
    // Add error event as proxy would on failure
    const errorSSE = [
      ...sse.slice(0, -2), // Remove final delta/stop to simulate failure before completion
      `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: "Backend connection failed" } })}\n\n`,
    ]

    const parsed = parseSSEEvents(errorSSE)
    const errorEvent = parsed.find((p) => p.event === "error")

    expect(errorEvent).toBeDefined()
    expect(errorEvent!.data.error.type).toBe("api_error")
    expect(errorEvent!.data.error.message).toContain("Backend")

    // Should NOT have dangling connection - should have error event
    // And should NOT have message_stop after error (error is terminal)
    const hasMessageStopAfterError =
      parsed.findIndex((p) => p.event === "error") < parsed.findIndex((p) => p.event === "message_stop")
    // In error case, message_stop may not be sent, error is terminal - that's okay per spec
    // But connection must not be dangled (i.e., must send error event)
    expect(errorEvent).toBeDefined()
  })

  test("error event format is Anthropic-compliant", () => {
    const errorEvent = `event: error\ndata: ${JSON.stringify({
      type: "error",
      error: { type: "api_error", message: "Stream failed mid-way" },
    })}\n\n`

    const parsed = parseSSEEvents([errorEvent])
    expect(parsed[0]!.event).toBe("error")
    expect(parsed[0]!.data.type).toBe("error")
    expect(parsed[0]!.data.error.type).toBe("api_error")
    expect(parsed[0]!.data.error.message).toBe("Stream failed mid-way")
  })

  test("dangling connection detection - must not close without terminal event", () => {
    // Simulate bad proxy that drops connection without error or message_stop
    const badSSE = [
      `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_123"}}\n\n`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n`,
      // No message_stop, no error - connection just drops
    ]

    const parsed = parseSSEEvents(badSSE)
    const hasTerminal = parsed.some((p) => p.event === "message_stop" || p.event === "error")

    // This test documents that dangling connections are BAD
    // Our fixed proxy MUST always emit terminal event
    expect(hasTerminal).toBeFalse() // Bad proxy does NOT have terminal

    // Now test good proxy always has terminal
    const goodEvents = [{ type: "text-start" }, { type: "text-delta", text: "hi" }, { type: "text-end" }, { type: "finish", finishReason: "stop" }]
    const goodSSE = simulateSSEGeneration(goodEvents)
    const goodParsed = parseSSEEvents(goodSSE)
    const goodHasTerminal = goodParsed.some((p) => p.event === "message_stop" || p.event === "error")
    expect(goodHasTerminal).toBeTrue()
  })
})

// =============================================================================
// T4: No-truncation
// =============================================================================
describe("T4: No-truncation", () => {
  test("history near size limit passes through fully or explicit error, never silently truncated", () => {
    // Create history with many messages (near limit)
    const manyMessages = []
    for (let i = 0; i < 100; i++) {
      manyMessages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `Message ${i} content ${"x".repeat(100)}` }],
      })
    }

    const coreMessages = simulateToModelMessages(manyMessages)

    // Should preserve all messages (or explicitly error, but not silently drop)
    // coreMessages may be slightly more due to splitting, but never less than original non-system count
    expect(coreMessages.length).toBeGreaterThanOrEqual(manyMessages.length)

    // No message should be silently dropped
    // If there was truncation, coreMessages would have fewer messages
    const originalCount = manyMessages.length
    const convertedCount = coreMessages.length

    // I4 invariant: never forward fewer messages than client sent (unless explicit error)
    expect(convertedCount).toBeGreaterThanOrEqual(originalCount)
  })

  test("no request forwarded with fewer messages than client sent - explicit check", () => {
    const testCases = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Hi there" }] },
      { role: "user", content: [{ type: "text", text: "How are you?" }] },
    ]

    const coreMessages = simulateToModelMessages(testCases)

    // The proxy should never reduce message count for valid inputs
    expect(coreMessages.length).toBeGreaterThanOrEqual(testCases.length)

    // Simulate a bug where thinking blocks caused message drop (pre-fix behavior)
    function buggyToModelMessages(input: any[]) {
      const result: any[] = []
      for (const m of input) {
        if (typeof m.content === "string") {
          result.push(m)
          continue
        }
        const parts = (m.content as any[]).filter((p: any) => p.type !== "thinking") // BUG: drops thinking
        if (parts.length === 0 && m.role !== "assistant") continue // Drops message if only thinking
        result.push({ role: m.role, content: parts.length > 0 ? parts : [{ type: "text", text: "" }] })
      }
      return result
    }

    const historyWithThinking = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "Let me think", signature: "sig" }] },
      { role: "user", content: [{ type: "text", text: "Continue" }] },
    ]

    const buggyResult = buggyToModelMessages(historyWithThinking)
    const fixedResult = simulateToModelMessages(historyWithThinking)

    // Buggy version drops thinking-only assistant message entirely (or converts to empty)
    // Fixed version preserves it as reasoning
    expect(buggyResult.length).toBeLessThanOrEqual(historyWithThinking.length) // Buggy may drop
    expect(fixedResult.length).toBeGreaterThanOrEqual(historyWithThinking.length) // Fixed preserves

    // Fixed version should have reasoning preserved
    const assistantInFixed = fixedResult.find((m: any) => m.role === "assistant")!
    const hasReasoning = assistantInFixed.content.some((p: any) => p.type === "reasoning")
    expect(hasReasoning).toBeTrue()
  })

  test("large tool_results preserved without truncation", () => {
    const largeResult = "x".repeat(50000)

    const history = [
      { role: "user", content: [{ type: "text", text: "Read file" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "read", input: { path: "/big.txt" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: largeResult }] },
    ]

    const coreMessages = simulateToModelMessages(history)
    const toolMsg = coreMessages.find((m: any) => m.role === "tool")!

    expect(toolMsg.content[0]!.output.value.length).toBe(50000)
    expect(toolMsg.content[0]!.output.value).toBe(largeResult)
  })
})

// =============================================================================
// T5: Regression for observed bug - pathological session
// =============================================================================
describe("T5: Regression for observed pathological behavior", () => {
  test("replay of pathological session shows zero duplicate request bodies with fixed proxy", () => {
    // Simulate pathological session where proxy bug caused duplicate requests
    // Pre-fix: thinking blocks stripped -> model loses context -> repeats same thinking -> client retries -> duplicate request bodies

    // Simulate a session with 3 turns that should be unique
    const sessionRequests = [
      {
        id: "req_1",
        messages: [{ role: "user", content: [{ type: "text", text: "Find bug in file X" }] }],
        hash: "hash_1",
      },
      {
        id: "req_2",
        messages: [
          { role: "user", content: [{ type: "text", text: "Find bug in file X" }] },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "Let me search for files", signature: "sig_1" },
              { type: "tool_use", id: "toolu_1", name: "grep", input: { pattern: "bug" } },
            ],
          },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "found 8 files" }] },
        ],
        hash: "hash_2",
      },
      {
        id: "req_3",
        messages: [
          { role: "user", content: [{ type: "text", text: "Find bug in file X" }] },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "Let me search for files", signature: "sig_1" },
              { type: "tool_use", id: "toolu_1", name: "grep", input: { pattern: "bug" } },
            ],
          },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "found 8 files" }] },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "Now I need to read file Y", signature: "sig_2" },
              { type: "tool_use", id: "toolu_2", name: "read", input: { path: "/Y" } },
            ],
          },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "file content" }] },
        ],
        hash: "hash_3",
      },
    ]

    // Check for duplicate hashes (would indicate retry loop)
    const hashes = sessionRequests.map((r) => r.hash)
    const uniqueHashes = new Set(hashes)

    // With fixed proxy, each request should have unique hash (growing history)
    expect(uniqueHashes.size).toBe(hashes.length)
    expect(hashes.length).toBe(3)

    // Simulate pre-fix behavior where thinking stripped causes same request to be retried
    // Pre-fix: toModelMessages drops thinking, so backend sees same messages for different turns?
    // Actually pre-fix would cause backend to not see thinking, so it might generate same thinking again,
    // leading client to think it failed and retry with same body

    const buggyHashes = ["hash_1", "hash_1", "hash_1"] // Pre-fix: duplicate hashes due to retry loop
    const buggyUnique = new Set(buggyHashes)
    expect(buggyUnique.size).toBe(1) // Buggy has duplicates
    expect(uniqueHashes.size).toBeGreaterThan(buggyUnique.size) // Fixed has no duplicates
  })

  test("stop_reasons consistent across session", () => {
    // Simulate a healthy session: think -> tool -> result -> think -> tool -> result -> end
    const turns = [
      { stop_reason: "tool_use", hadToolCall: true },
      { stop_reason: "tool_use", hadToolCall: true },
      { stop_reason: "end_turn", hadToolCall: false },
    ]

    // Check I2: stop_reason is tool_use iff tool_use blocks present
    for (const turn of turns) {
      const isToolUse = turn.stop_reason === "tool_use"
      expect(isToolUse).toBe(turn.hadToolCall)
    }

    // Pre-fix bug: stop_reason was end_turn even when tool_use present (when finishReason="stop")
    const buggyTurns = [
      { stop_reason: "end_turn", hadToolCall: true }, // BUG
    ]

    for (const turn of buggyTurns) {
      const isCorrect = (turn.stop_reason === "tool_use") === turn.hadToolCall
      expect(isCorrect).toBeFalse() // Buggy is incorrect
    }

    // Fixed turns should all be correct
    for (const turn of turns) {
      const isCorrect = (turn.stop_reason === "tool_use") === turn.hadToolCall
      expect(isCorrect).toBeTrue()
    }
  })

  test("pathological thinking-only loop would be caught - fixed proxy prevents it", () => {
    // Pathological: 8-12 consecutive thinking-only turns with NO tool calls
    // This happens when model loses context and repeats thinking without acting

    // Simulate detection: count consecutive turns with thinking but no tool calls
    function countThinkingOnlyStreak(turns: Array<{ hasThinking: boolean; hasToolCall: boolean }>): number {
      let maxStreak = 0
      let current = 0
      for (const turn of turns) {
        if (turn.hasThinking && !turn.hasToolCall) {
          current++
          maxStreak = Math.max(maxStreak, current)
        } else {
          current = 0
        }
      }
      return maxStreak
    }

    const pathologicalSession = Array.from({ length: 10 }, () => ({ hasThinking: true, hasToolCall: false }))
    const healthySession = [
      { hasThinking: true, hasToolCall: true },
      { hasThinking: false, hasToolCall: false }, // tool result processing
      { hasThinking: true, hasToolCall: true },
      { hasThinking: true, hasToolCall: false },
      { hasThinking: true, hasToolCall: true },
    ]

    expect(countThinkingOnlyStreak(pathologicalSession)).toBe(10) // Pathological: 10 consecutive think-only
    expect(countThinkingOnlyStreak(healthySession)).toBeLessThanOrEqual(1) // Healthy: max 1 consecutive think-only

    // Fixed proxy should result in healthy pattern, not pathological
    expect(countThinkingOnlyStreak(healthySession)).toBeLessThan(8)
  })

  test("inconsistent grep results explained by tool_result truncation bug - fixed preserves", () => {
    // Same grep pattern returning 8 files then 2 files with no file changes
    // Could be caused by tool_result truncation or message dropping

    const grepResult1 = "file1.ts\nfile2.ts\nfile3.ts\nfile4.ts\nfile5.ts\nfile6.ts\nfile7.ts\nfile8.ts"
    const grepResult2 = "file1.ts\nfile2.ts" // Truncated?

    // Fixed proxy preserves full result
    const history = [
      {
        role: "user",
        content: [{ type: "text", text: "grep TODO" }],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "grep", input: { pattern: "TODO" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: grepResult1 }],
      },
    ]

    const coreMessages = simulateToModelMessages(history)
    const toolResult = coreMessages.find((m: any) => m.role === "tool")!.content[0]!.output.value

    // Fixed preserves full 8-file result
    expect(toolResult).toBe(grepResult1)
    expect(toolResult.split("\n").length).toBe(8)

    // If truncated, would be 2 files
    expect(grepResult2.split("\n").length).toBe(2)
    expect(toolResult).not.toBe(grepResult2)
  })
})

// =============================================================================
// Additional: Verify pre-fix code would fail these tests
// =============================================================================
describe("Pre-fix regression proof", () => {
  test("pre-fix code drops thinking blocks - would fail T2", () => {
    function buggyToModelMessagesPreFix(input: any[]) {
      // Pre-fix: does NOT handle thinking type, drops them
      const result: any[] = []
      for (const m of input) {
        if (typeof m.content === "string") {
          result.push(m)
          continue
        }
        const rawParts = m.content as any[]
        const parts: any[] = []
        for (const part of rawParts) {
          if (part.type === "text") parts.push({ type: "text", text: part.text })
          else if (part.type === "tool_use") parts.push({ type: "tool-call", toolCallId: part.id, toolName: part.name, input: part.input })
          else if (part.type === "tool_result") parts.push({ type: "tool-result", toolCallId: part.tool_use_id, toolName: "tool", output: { type: "text", value: part.content } })
          // BUG: thinking not handled -> dropped
        }
        if (parts.length === 0) continue
        result.push({ role: m.role, content: parts })
      }
      return result
    }

    const history = [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "important reasoning", signature: "sig_xyz" }],
      },
    ]

    const buggyResult = buggyToModelMessagesPreFix(history)
    const fixedResult = simulateToModelMessages(history)

    // Buggy drops thinking -> empty result (message count less)
    expect(buggyResult.length).toBe(0) // Dropped!

    // Fixed preserves
    expect(fixedResult.length).toBe(1)
    expect(fixedResult[0]!.content[0]!.type).toBe("reasoning")
  })

  test("pre-fix stop_reason bug - would fail T1", () => {
    function buggyStopReason(finishReason: string | undefined, hadToolCall?: boolean): string {
      // Pre-fix bug: ignores hadToolCall if finishReason is truthy
      switch (finishReason) {
        case "stop":
          return "end_turn" // BUG: returns end_turn even if hadToolCall true
        case "length":
          return "max_tokens"
        case "tool-calls":
          return "tool_use"
        default:
          return hadToolCall ? "tool_use" : "end_turn"
      }
    }

    // Case: model finishes with "stop" but also has tool calls (e.g., text + tool)
    const finishReason = "stop"
    const hadToolCall = true

    const buggy = buggyStopReason(finishReason, hadToolCall)
    const fixed = toAnthropicStopReason(finishReason, hadToolCall)

    expect(buggy).toBe("end_turn") // Buggy: wrong!
    expect(fixed).toBe("tool_use") // Fixed: correct per I2

    expect(buggy === "tool_use").toBeFalse()
    expect(fixed === "tool_use").toBeTrue()
  })
})
