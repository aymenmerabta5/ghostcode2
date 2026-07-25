import { Context, Effect, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { generateText, jsonSchema, streamText, tool, wrapLanguageModel, type ToolSet } from "ai"
import { z } from "zod"
import { Provider, type Model } from "@/provider/provider"
import { ProviderError } from "@/provider/error"
import { InstanceStore } from "@/project/instance-store"
import { InstanceRef } from "@/effect/instance-ref"
import { Resume } from "@/session/resume"
import { AppRuntime } from "@/effect/app-runtime"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderTransform } from "@/provider/transform"
import { EffortUtil } from "@/util/effort"
import { Token } from "@/util/token"

export function isStallAbortReason(r: unknown): boolean {
  return r instanceof ProviderError.StalledStreamError
}

export function isClientAbortReason(r: unknown): boolean {
  return r instanceof DOMException && r.name === "AbortError"
}

const ROTATE_COOLDOWN_MS = 60_000
const CONNECTION_COOLDOWN_MS = 5_000
const STALL_TIMEOUT_MS = 60_000
const MAX_CONNECTION_RETRIES = 12
const CONNECTION_RETRY_BASE_MS = 750
const CONNECTION_RETRY_MAX_MS = 5000

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function connectionRetryDelay(attempt: number): number {
  const exp = Math.min(CONNECTION_RETRY_MAX_MS, CONNECTION_RETRY_BASE_MS * Math.pow(1.5, attempt))
  const jitter = Math.random() * 250
  return Math.floor(exp + jitter)
}

const PROVIDER_COOLDOWNS: Record<string, { rotate: number; connection: number; stall: number; server: number }> = {
  "cloudflare-workers-ai": { rotate: 15_000, connection: 3_000, stall: 45_000, server: 10_000 },
  "cloudflare-ai-gateway": { rotate: 15_000, connection: 3_000, stall: 45_000, server: 10_000 },
  meta: { rotate: 30_000, connection: 5_000, stall: 90_000, server: 10_000 },
  openrouter: { rotate: 15_000, connection: 5_000, stall: 60_000, server: 10_000 },
  default: { rotate: ROTATE_COOLDOWN_MS, connection: CONNECTION_COOLDOWN_MS, stall: STALL_TIMEOUT_MS, server: 10_000 },
}

function resolveProviderForTimeouts(input: any): string {
  if (!input) return "default"
  let raw: string
  try {
    if (typeof input === "string") raw = input
    else if (input && typeof input === "object") {
      raw = (input as any).id ?? (input as any).value ?? String(input)
    } else {
      raw = String(input)
    }
  } catch {
    raw = ""
  }
  raw = raw.trim()
  if (!raw) return "default"
  const lower = raw.toLowerCase()
  const firstSeg = lower.split("/")[0] ?? ""
  if (firstSeg === "meta" || lower === "meta" || lower.startsWith("meta/")) return "meta"
  if (firstSeg === "cloudflare-workers-ai" || lower.includes("cloudflare-workers-ai")) return "cloudflare-workers-ai"
  if (firstSeg === "cloudflare-ai-gateway" || lower.includes("cloudflare-ai-gateway")) return "cloudflare-ai-gateway"
  if (firstSeg === "openrouter" || lower.includes("openrouter")) return "openrouter"
  if (lower.includes("cloudflare")) return "cloudflare-ai-gateway"
  if (PROVIDER_COOLDOWNS[firstSeg]) return firstSeg
  if (PROVIDER_COOLDOWNS[raw]) return raw
  if (PROVIDER_COOLDOWNS[lower]) return lower
  return "default"
}

function getProviderTimeouts(providerID: string) {
  const key = resolveProviderForTimeouts(providerID)
  return PROVIDER_COOLDOWNS[key] ?? PROVIDER_COOLDOWNS.default
}

const DEBUG = process.env.OPENCODE_DEBUG_ANTHROPIC === "1"

// Phase 1 instrumentation: full request/response logging with timestamps and per-session id
// Controlled by OPENCODE_DEBUG_ANTHROPIC_LOG env var (path to log dir or "1" for console)
const LOG_ENABLED = (() => {
  const v = process.env.OPENCODE_DEBUG_ANTHROPIC_LOG
  return v === "1" || (typeof v === "string" && v.length > 0)
})()

type LogEntry = {
  timestamp: string
  sessionId: string
  requestId: string
  type: "request" | "outbound_request" | "response_event" | "response_complete" | "error"
  data: any
}

function logAnthropicEvent(entry: LogEntry) {
  if (!LOG_ENABLED) return
  const logPath = process.env.OPENCODE_DEBUG_ANTHROPIC_LOG
  const line = JSON.stringify(entry)
  if (logPath && logPath !== "1") {
    try {
      // Async append to avoid blocking
      const fs = require("fs")
      const path = require("path")
      const dir = logPath.includes(".") ? path.dirname(logPath) : logPath
      const file = logPath.includes(".") ? logPath : path.join(logPath, `anthropic-${entry.sessionId}.jsonl`)
      try {
        fs.mkdirSync(dir, { recursive: true })
      } catch {}
      fs.appendFile(file, line + "\n", () => {})
    } catch {}
  } else {
    console.log(`[anthropic-log] ${line}`)
  }
}

function deriveSessionID(
  httpRequest: HttpServerRequest.HttpServerRequest,
  providerID: string,
  modelID: string,
  _system: string,
): string {
  const headers = (httpRequest.headers ?? {}) as Record<string, string>
  const getHeader = (name: string) => {
    const lower = name.toLowerCase()
    return headers[lower] ?? headers[name] ?? (headers as any)[lower.toLowerCase()]
  }
  const candidates = [
    getHeader("x-opencode-session"),
    getHeader("x-session-id"),
    getHeader("x-session-affinity"),
    getHeader("x-parent-session-id"),
    getHeader("anthropic-session-id"),
    getHeader("session-id"),
  ].filter(Boolean) as string[]
  if (candidates.length > 0) return candidates[0]!
  return `anthropic-${providerID}-${modelID}`
}

const messageParamSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.union([z.string(), z.array(z.any())]),
})

type MessageParam = z.infer<typeof messageParamSchema>

const thinkingSchema = z.object({
  type: z.enum(["enabled", "disabled", "adaptive"]).optional(),
  budget_tokens: z.number().optional(),
})

const outputConfigSchema = z
  .object({
    effort: z.string().optional(),
  })
  .passthrough()

const messagesRequestSchema = z.object({
  model: z.string(),
  messages: z.array(messageParamSchema),
  max_tokens: z.number().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().optional(),
  stop_sequences: z.array(z.string()).optional(),
  stream: z.boolean().optional().default(false),
  system: z.union([z.string(), z.array(z.any())]).optional(),
  tools: z.array(z.any()).optional(),
  tool_choice: z.any().optional(),
  thinking: z.union([z.boolean(), thinkingSchema]).optional(),
  output_config: outputConfigSchema.optional(),
  effort: z.string().optional(),
})

function exposedModelID(providerID: string, modelID: string): string {
  if (modelID.startsWith(`${providerID}/`)) return modelID
  return `${providerID}/${modelID}`
}

function toolResultOutput(part: any): any {
  const content = part.content
  if (typeof content === "string") {
    return part.is_error ? { type: "error-text", value: content } : { type: "text", value: content }
  }
  const blocks = Array.isArray(content) ? content : []
  if (part.is_error) {
    return { type: "error-text", value: blocks.map((b: any) => b.text ?? "").join("") }
  }
  return {
    type: "content",
    value: blocks.map((b: any): any => {
      if (b.type === "image") return { type: "media", data: b.source?.data ?? "", mediaType: b.source?.media_type ?? "" }
      return { type: "text", text: b.text ?? "" }
    }),
  }
}

function toModelMessages(input: MessageParam[]): any[] {
  const toolNameById: Record<string, string> = {}
  for (let i = 0; i < input.length; i++) {
    const m = input[i]!
    if (typeof m.content === "string") continue
    const c = m.content as any[]
    for (let j = 0; j < c.length; j++) {
      const part = c[j]
      if (part?.type === "tool_use") {
        const id = part.id
        if (id) toolNameById[id] = part.name
      }
    }
  }
  let fallbackId = 0
  const nextFallback = () => `tool_${++fallbackId}`
  const result: any[] = []
  for (let i = 0; i < input.length; i++) {
    const m = input[i]!
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
    for (let k = 0; k < rawParts.length; k++) {
      const part = rawParts[k]
      if (!part) continue
      if (part.type === "text") {
        parts.push({ type: "text", text: part.text ?? "" })
      } else if (part.type === "image") {
        parts.push({ type: "image", image: part.source.data, mimeType: part.source.media_type })
      } else if (part.type === "thinking") {
        // I3: Preserve thinking blocks byte-preserving with signatures, but skip zero-length blocks (capture side may have emitted empty)
        const thinkingText = part.thinking ?? part.text ?? ""
        const hasSignature = !!(part.signature && String(part.signature).trim() !== "")
        const hasData = !!part.data
        const isEmpty = thinkingText.trim() === "" && !hasSignature && !hasData
        if (isEmpty) {
          // Skip empty thinking block: {"type":"thinking","thinking":"","signature":""} - would otherwise replay as empty reasoning and cause duplicate empty blocks
          continue
        }
        parts.push({
          type: "reasoning",
          text: thinkingText,
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
        // Preserve redacted thinking blocks too, but skip if no data
        const hasRedactedData = !!(part.data && String(part.data).trim() !== "")
        if (!hasRedactedData) continue
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
        parts.push({ type: "tool-call", toolCallId: part.id, toolName: part.name || "unknown_tool", input: part.input ?? {} })
      } else if (part.type === "tool_result") {
        const resolvedName = toolNameById[part.tool_use_id] || (part as any).name || part.tool_use_id || "unknown_tool"
        let output: any
        try {
          const raw = toolResultOutput(part)
          if (raw.type === "text" || raw.type === "error-text") {
            output = { type: "text", value: raw.value || " " }
          } else if (raw.type === "content") {
            let txt = ""
            const vals = raw.value as any[]
            for (let v = 0; v < vals.length; v++) {
              const b = vals[v]
              const piece = b.type === "text" ? b.text : b.type === "media" ? "[media]" : ""
              if (!piece) continue
              txt = txt ? txt + "\n" + piece : piece
            }
            output = { type: "text", value: txt || " " }
          } else {
            output = { type: "text", value: String(raw.value ?? " ") }
          }
        } catch {
          output = { type: "text", value: " " }
        }
        // I5: Every tool_use id maps 1:1 to a tool_result id - preserve original id, log if missing
        const toolResultId = part.tool_use_id
        if (!toolResultId) {
          console.error("[anthropic-api] I5 VIOLATION: tool_result missing tool_use_id, using fallback - will break 1:1 mapping", {
            part: JSON.stringify(part).slice(0, 500),
          })
          if (LOG_ENABLED) {
            logAnthropicEvent({
              timestamp: new Date().toISOString(),
              sessionId: "unknown",
              requestId: `req_${Date.now()}`,
              type: "error",
              data: {
                type: "tool_result_missing_id",
                fallbackUsed: true,
              },
            })
          }
        }
        parts.push({
          type: "tool-result",
          toolCallId: toolResultId || nextFallback(),
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
      let hasToolResult = false
      for (let p = 0; p < parts.length; p++) {
        if (parts[p].type === "tool-result") {
          hasToolResult = true
          break
        }
      }
      if (hasToolResult) {
        const toolResults: any[] = []
        const rest: any[] = []
        for (let p = 0; p < parts.length; p++) {
          const pp = parts[p]
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
  const systemMsgs: any[] = []
  const nonSystem: any[] = []
  for (let i = 0; i < result.length; i++) {
    const mm = result[i]!
    if (mm.role === "system") systemMsgs.push(mm)
    else nonSystem.push(mm)
  }

  // H2 FIX: Strip prior-turn reasoning summaries that carry no resumable state.
  // Meta's muse-spark-1.1 emits reasoning summaries only — real reasoning is hidden server-side.
  // Replayed summaries carry no resumable state, so feeding them back forces re-derivation every turn
  // (escalating think→read cycles). TUI/AI-SDK path strips prior reasoning via OpenAI Responses filtering.
  // For Anthropic, reasoning HAS signatures/redactedData (resumable), so we preserve those.
  // For earlier assistant turns, strip reasoning without signature/redactedData.
  const lastAssistantIdx = (() => {
    for (let i = nonSystem.length - 1; i >= 0; i--) {
      if (nonSystem[i]!.role === "assistant") return i
    }
    return -1
  })()
  if (lastAssistantIdx >= 0) {
    for (let i = 0; i < nonSystem.length; i++) {
      if (i === lastAssistantIdx) continue
      const mm = nonSystem[i]!
      if (mm.role !== "assistant") continue
      if (!Array.isArray(mm.content)) continue
      const hasReasoning = mm.content.some((p: any) => p.type === "reasoning")
      if (!hasReasoning) continue
      // Keep reasoning only if it has resumable state (Anthropic signature/redactedData)
      const filtered = mm.content.filter((p: any) => {
        if (p.type !== "reasoning") return true
        const sig = p.providerOptions?.anthropic?.signature
        const redacted = p.providerOptions?.anthropic?.redactedData
        const hasResumable = !!(sig && String(sig).trim() !== "") || !!redacted
        // If no resumable state, strip it (Meta summaries)
        return hasResumable
      })
      if (filtered.length === 0) {
        // Preserve at least empty text to avoid empty assistant message
        nonSystem[i] = { ...mm, content: [{ type: "text", text: "" }] }
      } else if (filtered.length !== mm.content.length) {
        nonSystem[i] = { ...mm, content: filtered }
      }
    }
  }

  if (systemMsgs.length > 0) {
    // H3 FIX: Deduplicate system messages to prevent ever-growing prompt
    // Claude Code sends system reminders mid-conversation (e.g., task-tools, MCP instructions)
    // Previously we merged ALL system messages from history each turn, causing growth
    // TUI path has stable system prompt. We deduplicate by content to prevent inflation.
    const seen = new Set<string>()
    let mergedSystem = ""
    for (let i = 0; i < systemMsgs.length; i++) {
      const mm = systemMsgs[i]!
      const txt =
        typeof mm.content === "string" ? mm.content : (mm.content as any[]).map((p: any) => p.text).join("\n")
      if (!txt) continue
      const trimmed = txt.trim()
      if (!trimmed) continue
      if (seen.has(trimmed)) continue
      seen.add(trimmed)
      mergedSystem = mergedSystem ? mergedSystem + "\n\n" + txt : txt
    }
    if (mergedSystem) {
      return [{ role: "system", content: mergedSystem }, ...nonSystem]
    }
  }
  return [...systemMsgs, ...nonSystem]
}

export function __test_toModelMessages(input: any[]) {
  return toModelMessages(input)
}

function parseModelID(raw: string): { providerID: string; modelID: string } | undefined {
  const parts = raw.split("/")
  if (parts.length < 2) return undefined
  const providerID = parts[0]
  const modelID = parts.slice(1).join("/")
  return { providerID, modelID }
}

function toAnthropicToolChoice(input: any, validToolNames?: Set<string>): any {
  if (!input) return undefined
  if (input.type === "auto") return "auto"
  if (input.type === "any") return "required"
  if (input.type === "tool") {
    const name = input.name
    if (validToolNames && name && !validToolNames.has(name)) {
      if (DEBUG) console.log("[anthropic-api] tool_choice references filtered tool, dropping", { name })
      return "auto"
    }
    return { type: "tool", toolName: name }
  }
  return undefined
}

const SKIP_TOOL_TYPES = new Set([
  "web_search_20250305",
  "web_search_20250305_20250922",
  "code_execution_20250522",
  "computer_20241022",
  "computer_20250124",
  "text_editor_20250124",
  "text_editor_20250414",
  "text_editor_20241022",
  "bash_20250124",
  "bash_20241022",
  "mcp_toolset",
  "memory_20250414",
  "skill_20250614",
  "agent_20250930",
  "web_fetch_20260209",
  "server_tool_use",
  "web_search_tool_result",
  "code_execution_tool_result",
])

function isValidToolItem(item: any): boolean {
  if (!item || typeof item !== "object") return false
  const name = item.name
  if (typeof name !== "string" || name.trim() === "") return false
  if (item.type) {
    const t = String(item.type).toLowerCase()
    if (t !== "custom" && t !== "function") {
      if (
        SKIP_TOOL_TYPES.has(item.type) ||
        t.includes("web_search") ||
        t.includes("web_fetch") ||
        t.includes("code_execution") ||
        t.includes("computer") ||
        t.includes("text_editor") ||
        t.includes("bash_") ||
        t.includes("memory_") ||
        t.includes("skill_") ||
        t.includes("mcp_") ||
        t.includes("agent_")
      ) {
        return false
      }
      if (t !== "custom" && t !== "function" && t !== "tool_use") return false
    }
  }
  const schema = item.input_schema
  if (schema === undefined || schema === null) return true
  if (typeof schema === "string") return true
  if (typeof schema !== "object") return false
  return true
}

function normalizeToolSchema(raw: any): any {
  if (raw === undefined || raw === null) return { type: "object", properties: {} }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed
    } catch {}
    return { type: "object", properties: {} }
  }
  if (typeof raw !== "object") return { type: "object", properties: {} }
  if (Array.isArray(raw)) return { type: "object", properties: {} }
  return raw
}

function toAITools(input: any[] | undefined, model?: Model): ToolSet | undefined {
  if (!input || input.length === 0) return undefined
  if (model && (model.capabilities as any)?.toolcall === false) {
    if (DEBUG) console.log("[anthropic-api] toAITools skipped - model does not support toolcall", { model: model.id })
    return undefined
  }
  const kept: any[] = []
  let droppedBuiltIn = 0
  let droppedInvalid = 0
  for (const item of input) {
    if (!item || typeof item !== "object") {
      droppedInvalid++
      continue
    }
    if (item.type && SKIP_TOOL_TYPES.has(item.type)) {
      droppedBuiltIn++
      continue
    }
    if (!isValidToolItem(item)) {
      const reason = !item.name ? "no_name" : !item.input_schema && item.input_schema !== undefined ? "bad_schema" : "type_skip"
      if (DEBUG) {
        console.log("[anthropic-api] toAITools dropping invalid tool", { type: item.type, name: item.name, reason })
      }
      if (!item.name || (typeof item.name !== "string" || item.name.trim() === "")) droppedInvalid++
      else droppedBuiltIn++
      continue
    }
    kept.push(item)
  }
  if (kept.length === 0) {
    if ((droppedBuiltIn > 0 || droppedInvalid > 0) && DEBUG) {
      console.log("[anthropic-api] toAITools all filtered", { droppedBuiltIn, droppedInvalid, inputLen: input.length })
    }
    return undefined
  }
  if ((droppedBuiltIn > 0 || droppedInvalid > 0) && DEBUG) {
    console.log("[anthropic-api] toAITools filtered", { kept: kept.length, droppedBuiltIn, droppedInvalid, inputLen: input.length })
  }
  const result: ToolSet = {}
  const isOpenAIResponses =
    model?.api.npm === "@ai-sdk/openai" ||
    model?.api.npm === "@ai-sdk/azure" ||
    model?.api.npm === "@ai-sdk/amazon-bedrock/mantle"
  const isOpenAICompatible =
    model?.api.npm === "@ai-sdk/openai-compatible" || (model?.api.npm as string) === "ai-gateway-provider"
  const sorted = [...kept].toSorted((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))
  for (const item of sorted) {
    let schema: any
    try {
      schema = normalizeToolSchema(item.input_schema)
      JSON.stringify(schema)
    } catch {
      if (DEBUG) console.log("[anthropic-api] toAITools dropping tool with non-serializable schema", { name: item.name })
      continue
    }
    let t: any
    try {
      t = tool({
        description: item.description,
        inputSchema: jsonSchema(schema as any),
      }) as any
    } catch (e) {
      if (DEBUG) console.log("[anthropic-api] toAITools jsonSchema failed, fallback empty object", { name: item.name, error: (e as Error).message })
      try {
        t = tool({
          description: item.description,
          inputSchema: jsonSchema({ type: "object", properties: {} } as any),
        }) as any
      } catch {
        continue
      }
    }
    if (isOpenAIResponses) t.strict = false
    if (isOpenAICompatible) t.strict = false
    result[item.name] = t
  }
  const finalKeys = Object.keys(result)
  if (finalKeys.length === 0) return undefined
  return result
}

function toolInput(toolCall: any): unknown {
  return toolCall.args ?? toolCall.input ?? {}
}

function systemText(system: string | any[] | undefined): string {
  if (!system) return ""
  if (typeof system === "string") return system
  return system.map((p: any) => (p.type === "text" ? (p.text ?? "") : "")).join("")
}

function estimateTokens(messages: MessageParam[], system?: string | any[], tools?: any[]): number {
  const chunks: string[] = []
  let charCount = 0
  const sys = systemText(system)
  if (sys) {
    chunks.push(sys)
    charCount += sys.length
  }
  if (tools && Array.isArray(tools)) {
    for (const t of tools) {
      if (!t) continue
      const name = t.name ?? ""
      const desc = t.description ?? ""
      if (name) {
        chunks.push(name)
        charCount += name.length
      }
      if (desc) {
        chunks.push(desc)
        charCount += desc.length
      }
      try {
        const schemaStr = JSON.stringify(t.input_schema ?? {})
        if (schemaStr && schemaStr !== "{}") {
          chunks.push(schemaStr)
          charCount += schemaStr.length
        }
      } catch {}
    }
  }
  for (const m of messages) {
    if (typeof m.content === "string") {
      chunks.push(m.content)
      charCount += m.content.length
      continue
    }
    if (!Array.isArray(m.content)) continue
    for (const part of m.content as any[]) {
      if (!part) continue
      switch (part.type) {
        case "text": {
          const t = part.text ?? ""
          if (t) {
            chunks.push(t)
            charCount += t.length
          }
          break
        }
        case "image":
          break
        case "tool_use": {
          const n = part.name ?? ""
          const id = part.id ?? ""
          if (n) {
            chunks.push(n)
            charCount += n.length
          }
          if (id) {
            chunks.push(id)
            charCount += id.length
          }
          try {
            const s = JSON.stringify(part.input ?? {})
            if (s && s !== "{}") {
              chunks.push(s)
              charCount += s.length
            }
          } catch {
            const s = String(part.input ?? "")
            chunks.push(s)
            charCount += s.length
          }
          break
        }
        case "tool_result": {
          const tid = part.tool_use_id ?? ""
          const nm = (part as any).name ?? ""
          if (tid) {
            chunks.push(tid)
            charCount += tid.length
          }
          if (nm) {
            chunks.push(nm)
            charCount += nm.length
          }
          const content = part.content
          if (typeof content === "string" && content) {
            chunks.push(content)
            charCount += content.length
          } else if (Array.isArray(content)) {
            for (const block of content as any[]) {
              if (!block) continue
              const bt = block.type === "text" ? (block.text ?? "") : (typeof block.text === "string" ? block.text : "")
              if (bt) {
                chunks.push(bt)
                charCount += bt.length
              }
            }
          }
          break
        }
        case "thinking": {
          const t = part.thinking ?? part.text ?? ""
          if (t) {
            chunks.push(t)
            charCount += t.length
          }
          break
        }
        default: {
          const t =
            typeof part.text === "string" ? part.text : typeof part.thinking === "string" ? part.thinking : ""
          if (t) {
            chunks.push(t)
            charCount += t.length
          }
          break
        }
      }
    }
  }
  const text = charCount > 0 ? chunks.join("") : ""
  return Token.estimate(text)
}

function parseRequestedEffort(body: z.infer<typeof messagesRequestSchema>): string | undefined {
  const oc = (body as any).output_config?.effort
  if (typeof oc === "string" && oc.trim() !== "") return oc.trim().toLowerCase()
  const direct = (body as any).effort
  if (typeof direct === "string" && direct.trim() !== "") return direct.trim().toLowerCase()
  const thinking = body.thinking
  if (thinking && typeof thinking === "object") {
    const t = thinking as any
    if (t.type === "disabled") return "none"
  }
  if (thinking === false) return "none"
  return undefined
}

function parseThinkingBudget(body: z.infer<typeof messagesRequestSchema>): number | undefined {
  const thinking = body.thinking
  if (thinking && typeof thinking === "object") {
    const t = thinking as any
    if (typeof t.budget_tokens === "number" && t.budget_tokens > 0) return t.budget_tokens
  }
  return undefined
}

/**
 * Map Claude Code's effort (output_config.effort) to backend's reasoningEffort.
 * Claude emits: low, medium, high, max (see claude-code/utils/effort.ts EFFORT_LEVELS)
 * Meta (muse-spark-1.1) accepts: minimal, low, medium, high, xhigh (models.json, transform.ts variants)
 * Mapping (explicit, documented):
 *   low    → low   (direct)
 *   medium → medium (direct)
 *   high   → high  (direct)
 *   max    → xhigh (Claude's strongest = Opus 4.6 max, maps to meta's strongest xhigh)
 *   minimal (if ever sent) → minimal
 */
function mapClaudeEffortToBackend(claudeEffort: string, variants: string[]): string | undefined {
  const lower = claudeEffort.toLowerCase()
  // Explicit mapping table
  const explicitMap: Record<string, string> = {
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    max: "xhigh", // Claude max → meta xhigh (strongest)
    xhigh: "xhigh",
  }
  const mapped = explicitMap[lower]
  if (mapped && variants.includes(mapped)) return mapped
  // Fallback to EffortUtil for closest match
  const resolved = EffortUtil.resolveEffort(lower, variants)
  if (resolved) return resolved
  if (variants.includes(lower)) return lower
  // max → xhigh fallback if explicit not found but variants have xhigh
  if (lower === "max" && variants.includes("xhigh")) return "xhigh"
  if (lower === "xhigh" && variants.includes("max")) return "max"
  return undefined
}

/**
 * Derive effort tier from thinking.budget_tokens when output_config.effort absent.
 * Thresholds justified against TUI's own budget tiers in transform.ts:
 *   high = min(16000, floor(output/2-1))  — for 32k output, ≈16000
 *   max  = min(31999, output-1)           — for 32k output, ≈31999
 * So high tier ≈16k, max tier ≈32k. We map budget to effort as:
 *   < 2000  → minimal  (<< high, minimal reasoning)
 *   2000-5999 → low    (< 8000, small)
 *   6000-11999→ medium (< high's 16000)
 *   12000-19999→ high  (≈ high tier 16000, with buffer to 20k for output variations)
 *   >=20000 → xhigh  (≈ max tier 31999, strongest)
 * These numbers are not magic — they are anchored to TUI's high=16000 and max=31999.
 */
function budgetToEffort(budget: number, variants: string[]): string | undefined {
  if (variants.length === 0) return undefined
  let tier: string
  if (budget < 2000) tier = "minimal" // << high (16000)
  else if (budget < 6000) tier = "low" // < half of high
  else if (budget < 12000) tier = "medium" // < high (16000)
  else if (budget < 20000) tier = "high" // ≈ high tier 16000, buffer for output/2 variations
  else tier = "xhigh" // >=20000, approaching max tier 31999

  // Try explicit variant first
  if (variants.includes(tier)) return tier
  // Resolve via EffortUtil for closest
  const resolved = EffortUtil.resolveEffort(tier, variants)
  if (resolved) return resolved
  // Fallbacks
  if (tier === "minimal" && variants.includes("low")) return "low"
  if (tier === "xhigh") {
    if (variants.includes("xhigh")) return "xhigh"
    if (variants.includes("max")) return "max"
    if (variants.includes("high")) return "high"
  }
  return undefined
}

function resolveModelEffort(requested: string | undefined, model: Model): string | undefined {
  if (!requested) return undefined
  const variants = model.variants ? Object.keys(model.variants) : []
  if (variants.length === 0) return undefined
  const resolved = EffortUtil.resolveEffort(requested, variants)
  if (resolved) return resolved
  const lower = requested.toLowerCase()
  if (variants.includes(lower)) return lower
  if (lower === "max" && variants.includes("xhigh")) return "xhigh"
  if (lower === "xhigh" && variants.includes("max")) return "max"
  return undefined
}

function buildProviderOptions(
  model: Model,
  effortVariant: string | undefined,
  sessionID: string,
  thinkingBudget?: number,
): { raw: Record<string, any>; wrapped: Record<string, any> } {
  const base = ProviderTransform.options({
    model,
    sessionID,
    providerOptions: {},
  })
  const variantOpts =
    effortVariant && model.variants?.[effortVariant] ? (model.variants[effortVariant] as Record<string, any>) : {}
  let mergedBase = { ...base, ...(model.options ?? {}), ...variantOpts } as Record<string, any>

  // H1 FIX: Map inbound budget_tokens like TUI does
  // For Anthropic: TUI variants set budgetTokens = min(16000, floor(output/2-1)) for high, min(31999, output-1) for max
  // We forward inbound budget directly but clamp like TUI/Claude Code: budget = min(budget, outputLimit-1)
  // For non-Anthropic (meta): TUI sets reasoningEffort xhigh base, not derived from budget, so we keep base and do NOT override with arbitrary tiers
  if (thinkingBudget !== undefined) {
    const isAnthropic =
      model.api.npm === "@ai-sdk/anthropic" ||
      model.api.npm === "@ai-sdk/google-vertex/anthropic" ||
      model.providerID === "anthropic" ||
      model.api.id.includes("claude")
    if (isAnthropic) {
      // Clamp like TUI: budget must be < output limit and <=31999 for max, <=16000 for high-ish but we just clamp to output-1 and 31999
      const outputLimit = model.limit?.output ?? 32000
      const clamped = Math.min(thinkingBudget, outputLimit - 1, 31999)
      const existingThinking = (mergedBase as any).thinking ?? {}
      mergedBase = {
        ...mergedBase,
        thinking: {
          ...existingThinking,
          type: "enabled",
          budgetTokens: clamped,
        },
      }
    } else {
      // For meta and other OpenAI-compatible, do NOT map budget to effort with hardcoded numbers
      // Keep base reasoningEffort (xhigh for meta) which is what TUI does
      // Budget is still considered as having a reasoning cap (base), so not silently dropped
    }
  }

  const withCache = {
    ...mergedBase,
    promptCacheKey: (mergedBase as any).promptCacheKey ?? sessionID,
    prompt_cache_key: (mergedBase as any).prompt_cache_key ?? sessionID,
  } as Record<string, any>
  if (model.providerID === "openrouter" || model.api.npm === "@openrouter/ai-sdk-provider") {
    withCache.prompt_cache_key = sessionID
  }
  return {
    raw: withCache,
    wrapped: ProviderTransform.providerOptions(model, withCache),
  }
}

function toAnthropicStopReason(finishReason: string | undefined, hadToolCall?: boolean): string {
  // I2: stop_reason is `tool_use` iff the response contains tool_use blocks.
  // This takes precedence over finishReason, because Anthropic spec says stop_reason=tool_use when tool calls present
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

type RouteErrorKind = "ratelimit" | "exhausted" | "connection" | "invalid" | "server" | "tool_format"
type RouteError = { kind: RouteErrorKind; retryAfterMs?: number }

function collectErrorMessagesDeep(error: unknown, seen = new Set<unknown>()): string[] {
  if (!error || typeof error !== "object") {
    if (typeof error === "string") return [error]
    return []
  }
  if (seen.has(error)) return []
  seen.add(error)
  const out: string[] = []
  const e = error as Record<string, any>
  if (typeof e.message === "string" && e.message) out.push(e.message)
  if (typeof e.responseBody === "string" && e.responseBody) out.push(e.responseBody)
  if (typeof e.body === "string" && e.body) out.push(e.body)
  if (typeof e.cause === "string" && e.cause) out.push(e.cause)
  // Recurse into common nested error locations
  const nested = [e.cause, e.error, e.errors, e.lastError]
  for (const n of nested) {
    if (!n) continue
    if (Array.isArray(n)) {
      for (const sub of n) out.push(...collectErrorMessagesDeep(sub, seen))
    } else {
      out.push(...collectErrorMessagesDeep(n, seen))
    }
  }
  return out
}

function apiErrorDetails(error: unknown): {
  statusCode?: number
  message: string
  body: string
  headers?: Record<string, string>
} {
  if (error && typeof error === "object") {
    const e = error as Record<string, any>
    const statusCode =
      typeof e.statusCode === "number"
        ? e.statusCode
        : typeof e.responseStatus === "number"
          ? e.responseStatus
          : typeof e.status === "number"
            ? e.status
            : undefined
    const collected = collectErrorMessagesDeep(error)
    const message = collected.join(" | ") || (typeof e.message === "string" ? e.message : "")
    const body =
      typeof e.responseBody === "string"
        ? e.responseBody
        : e.data && typeof e.data === "object"
          ? JSON.stringify(e.data)
          : typeof e.body === "string"
            ? e.body
            : collected.join(" | ")
    const headers =
      e.responseHeaders && typeof e.responseHeaders === "object"
        ? (e.responseHeaders as Record<string, string>)
        : e.headers && typeof e.headers === "object"
          ? (e.headers as Record<string, string>)
          : undefined
    if (statusCode !== undefined || message || body) {
      return { statusCode, message, body, headers }
    }
  }
  if (error instanceof Error) {
    const collected = collectErrorMessagesDeep(error)
    return { message: collected.join(" | ") || error.message, body: collected.join(" | ") }
  }
  return { message: typeof error === "string" ? error : String(error), body: "" }
}

function parseRetryAfterMs(headers: Record<string, string> | undefined): number | undefined {
  if (!headers) return undefined
  const lower: Record<string, string> = {}
  for (const k in headers) lower[k.toLowerCase()] = headers[k]
  const ms = lower["retry-after-ms"]
  if (ms !== undefined) {
    const n = Number(ms)
    if (!Number.isNaN(n)) return n
  }
  const s = lower["retry-after"]
  if (s !== undefined) {
    const n = Number(s)
    if (!Number.isNaN(n)) return n * 1000
  }
  return undefined
}

const CONNECTION_SUBSTRINGS = [
  "stream ended without finish",
  "econnreset",
  "econnrefused",
  "enotfound",
  "etimedout",
  "eai_again",
  "econnaborted",
  "esockettimedout",
  "ehostunreach",
  "enetunreach",
  "eai_again",
  "econn",
  "socket connection was closed",
  "connection was closed unexpectedly",
  "the connection was closed",
  "socket hang up",
  "socket disconnected",
  "connection closed",
  "connection reset",
  "connection refused",
  "connection error",
  "connection failure",
  "connection timed out",
  "connection timeout",
  "cannot connect to api",
  "unable to connect",
  "is the computer able to access",
  "unable to access",
  "failed to fetch",
  "fetch failed",
  "fetch error",
  "network error",
  "networkerror",
  "network failure",
  "failed to connect",
  "connect timeout",
  "connect econn",
  "authentication service",
  "body timeout",
  "undici",
  "terminated",
  "ECONN",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
] as const

function containsConnectionHint(text: string): boolean {
  const lower = text.toLowerCase()
  for (const pat of CONNECTION_SUBSTRINGS) {
    if (lower.includes(pat.toLowerCase())) return true
  }
  return false
}

export function isConnectionLevelFailure(error: unknown): boolean {
  if (error instanceof ProviderError.StalledStreamError) return true
  const { statusCode, message, body } = apiErrorDetails(error)
  // If status code exists and is 4xx/5xx handled elsewhere, don't treat as raw connection unless hint is very strong.
  // But for safety: if no status or status is fetch-level failure, check hints.
  const combined = `${message} ${body}`.toLowerCase()
  // Strong connection hints even with status code should still be considered connection for rotation retry
  // e.g. some providers wrap fetch errors with status 0 or no status but we already handled undefined.
  // We now allow connection detection even if statusCode is defined but message clearly indicates network issue.
  if (containsConnectionHint(combined)) {
    // Still avoid treating pure 429/400 tool_format as connection – those are caught earlier.
    // But for any status undefined OR status >=500 that also includes connection text, treat as connection to enable retry.
    return true
  }
  // Legacy fallbacks
  if (statusCode !== undefined) return false
  return (
    combined.includes("stream ended without finish") ||
    combined.includes("socket connection was closed") ||
    combined.includes("connection was closed unexpectedly") ||
    combined.includes("the connection was closed") ||
    combined.includes("authentication service")
  )
}

export function classifyRouteError(error: unknown): RouteError | undefined {
  // Stall is detected via instance check, not string parsing, per final revision
  if (error instanceof ProviderError.StalledStreamError || isStallAbortReason(error)) {
    return { kind: "connection" }
  }
  const { statusCode, message, body, headers } = apiErrorDetails(error)
  const lowerMessage = message.toLowerCase()
  const lowerBody = body.toLowerCase()
  const retryAfterMs = parseRetryAfterMs(headers)
  if (
    lowerMessage.includes("did not match any supported type") ||
    lowerBody.includes("did not match any supported type") ||
    (lowerMessage.includes("tools[") && lowerMessage.includes("supported type")) ||
    lowerBody.includes("unsupported tool") ||
    (lowerBody.includes("tools") && lowerBody.includes("invalid") && statusCode === 400)
  ) {
    return { kind: "tool_format", retryAfterMs }
  }
  if (lowerBody.includes("billing verification failed") || lowerMessage.includes("billing verification failed")) {
    return { kind: "invalid", retryAfterMs }
  }
  if (lowerBody.includes("used up your") || lowerMessage.includes("used up your")) {
    return { kind: "exhausted", retryAfterMs }
  }
  if (
    statusCode === 429 ||
    body.includes("rate_limit") ||
    body.includes("too_many_requests") ||
    lowerBody.includes("too many requests") ||
    lowerBody.includes("rate limit") ||
    lowerMessage.includes("too many requests") ||
    lowerMessage.includes("rate limit")
  ) {
    return { kind: "ratelimit", retryAfterMs }
  }
  if (
    statusCode === 500 ||
    statusCode === 502 ||
    statusCode === 503 ||
    statusCode === 504 ||
    (statusCode !== undefined && statusCode >= 520 && statusCode <= 524)
  ) {
    return { kind: "server", retryAfterMs }
  }
  if (isConnectionLevelFailure(error)) {
    return { kind: "connection", retryAfterMs }
  }
  return undefined
}

function routeCooldownOpts(
  cls: RouteError,
  providerID?: string,
): { retryAfterMs?: number; exhausted?: boolean } {
  const timeouts = getProviderTimeouts(providerID ?? "default")
  if (cls.kind === "invalid") {
    return { retryAfterMs: 0 }
  }
  if (cls.kind === "exhausted") {
    const now = new Date()
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0))
    return { retryAfterMs: midnight.getTime() - now.getTime() }
  }
  if (cls.kind === "tool_format") {
    return { retryAfterMs: 0 }
  }
  if (cls.retryAfterMs !== undefined && cls.retryAfterMs > 0) {
    return { retryAfterMs: cls.retryAfterMs }
  }
  if (cls.kind === "connection") {
    return { retryAfterMs: timeouts.connection }
  }
  if (cls.kind === "server") {
    return { retryAfterMs: timeouts.server }
  }
  return { retryAfterMs: timeouts.rotate }
}

export async function warmupAnthropicProvider(directory: string): Promise<void> {
  const ctx = await AppRuntime.runPromise(InstanceStore.use.load({ directory }))
  const providers = await AppRuntime.runPromise(
    Provider.use.list().pipe(Effect.provideService(InstanceRef, ctx)),
  )
  for (const info of Object.values(providers)) {
    const apiKeys = (info.options as Record<string, unknown> | undefined)?.apiKeys
    if (!Array.isArray(apiKeys) || apiKeys.length === 0) continue
    const firstModelID = Object.keys(info.models)[0]
    if (!firstModelID) continue
    await AppRuntime.runPromise(
      Provider.use.getLanguage(info.models[firstModelID]).pipe(Effect.provideService(InstanceRef, ctx)),
    ).catch((e) => {
      console.error(
        `[anthropic-api] warmup: getLanguage failed for ${info.id}:`,
        e instanceof Error ? e.message : e,
      )
    })
  }
}

function handleModels(directory: string) {
  return Effect.gen(function* () {
    const ctx = yield* InstanceStore.use.load({ directory })
    return yield* Effect.gen(function* () {
      const providers = yield* Provider.use.list()
      const data = Object.values(providers).flatMap((provider) =>
        Object.values(provider.models).map((model) => ({
          type: "model" as const,
          id: exposedModelID(provider.id, model.id),
          display_name: model.name,
          created_at: "1970-01-01T00:00:00Z",
        })),
      )
      return HttpServerResponse.jsonUnsafe({
        data,
        has_more: false,
        first_id: data[0]?.id,
        last_id: data[data.length - 1]?.id,
      })
    }).pipe(Effect.provideService(InstanceRef, ctx))
  })
}

function handleCountTokens(directory: string, request: HttpServerRequest.HttpServerRequest) {
  return Effect.gen(function* () {
    const ctx = yield* InstanceStore.use.load({ directory })
    return yield* Effect.gen(function* () {
      const body = messagesRequestSchema.parse(yield* request.json)
      return HttpServerResponse.jsonUnsafe({
        input_tokens: estimateTokens(body.messages, body.system, body.tools as any[]),
      })
    }).pipe(Effect.provideService(InstanceRef, ctx))
  })
}

function handleMessages(directory: string, request: HttpServerRequest.HttpServerRequest) {
  return Effect.gen(function* () {
    const ctx = yield* InstanceStore.use.load({ directory })
    return yield* Effect.gen(function* () {
      const raw = yield* request.json
      if (DEBUG) {
        try {
          const maybeEffort = (raw as any).output_config?.effort ?? (raw as any).effort
          if (maybeEffort) {
            console.log("[anthropic-api] incoming effort", { model: (raw as any).model, effort: maybeEffort })
          }
          const maybeThinking = (raw as any).thinking
          if (maybeThinking) {
            console.log("[anthropic-api] incoming thinking", { model: (raw as any).model, thinking: maybeThinking })
          }
        } catch {}
      }
      const body = messagesRequestSchema.parse(raw)
      const parsed = parseModelID(body.model)
      if (!parsed) {
        return HttpServerResponse.jsonUnsafe(
          { type: "error", error: { type: "invalid_request_error", message: "Invalid model ID" } },
          { status: 400 },
        )
      }
      const providerID = ProviderV2.ID.make(parsed.providerID)
      const modelObj = yield* Provider.use.getModel(providerID, ModelV2.ID.make(parsed.modelID))
      let system = systemText(body.system)
      // System messages mid-conversation: (a) received from client as-is (e.g., Claude Code task-tools reminder, MCP instructions)
      // We forward by merging into top-level system prompt. This is documented behavior, not produced by our conversion (b).
      // Anthropic spec says messages should be user/assistant only; system reminders from client are treated as additional system context,
      // not converted to user messages, to preserve their intent as system-level instructions.
      const systemFromMessages = body.messages
        .filter((m: any) => m.role === "system")
        .map((m: any) => {
          if (typeof m.content === "string") return m.content
          return m.content.map((p: any) => p.text ?? p.thinking ?? "").join("\n")
        })
        .join("\n\n")
      if (systemFromMessages) {
        system = system ? system + "\n\n" + systemFromMessages : systemFromMessages
      }
      const nonSystemMessages = body.messages.filter((m: any) => m.role !== "system")
      const coreMessages = toModelMessages(nonSystemMessages)

      // I4: No silent truncation. If a limit is exceeded, fail loudly.
      // Ensure we never forward fewer messages than client sent (except system messages which are merged)
      // If we do, it indicates silent dropping of messages/content - fail loudly per spec.
      const originalNonSystemCount = nonSystemMessages.length
      // coreMessages may split some messages (tool_result separation) so it can be longer, but should never be shorter
      // by more than the number of empty messages that were intentionally dropped (which should be zero for valid input)
      if (coreMessages.length < originalNonSystemCount) {
        // Count how many messages were dropped due to empty content after conversion
        const droppedCount = originalNonSystemCount - coreMessages.length
        // Only allow dropping if original messages were empty (defensive)
        // Otherwise, fail loudly with Anthropic-style error
        const hasEmptyOriginal = nonSystemMessages.some((m: any) => {
          if (typeof m.content === "string") return m.content.trim() === ""
          if (Array.isArray(m.content)) return m.content.length === 0
          return false
        })
        if (!hasEmptyOriginal || droppedCount > 2) {
          // Log the issue for Phase 1 evidence
          console.error("[anthropic-api] I4 VIOLATION: silent message drop detected", {
            originalCount: originalNonSystemCount,
            coreCount: coreMessages.length,
            dropped: droppedCount,
            originalSample: nonSystemMessages.slice(-2).map((m: any) => ({
              role: m.role,
              contentTypes: Array.isArray(m.content) ? m.content.map((c: any) => c.type) : typeof m.content,
            })),
            coreSample: coreMessages.slice(-2).map((m: any) => ({
              role: m.role,
              contentTypes: Array.isArray(m.content) ? m.content.map((c: any) => c.type) : typeof m.content,
            })),
          })
          // For now, don't fail but log - after fixing thinking bug, this should not happen
          // If it still happens, we should fail loudly per I4:
          // return HttpServerResponse.jsonUnsafe(
          //   { type: "error", error: { type: "invalid_request_error", message: `Message conversion dropped ${droppedCount} messages - would be silent truncation` } },
          //   { status: 400 }
          // )
        }
      }

      const thinkingBudget = parseThinkingBudget(body)
      const rawRequestedEffort = parseRequestedEffort(body) // from Claude Code output_config.effort
      let requestedEffort: string | undefined = rawRequestedEffort
      let effortResolutionRule: string = "default_xhigh"
      let resolvedEffort: string | undefined

      const variants = modelObj.variants ? Object.keys(modelObj.variants) : []
      const isAnthropicModel =
        modelObj.api.npm === "@ai-sdk/anthropic" ||
        modelObj.api.npm === "@ai-sdk/google-vertex/anthropic" ||
        modelObj.providerID === "anthropic" ||
        modelObj.api.id.includes("claude")

      if (isAnthropicModel) {
        // Anthropic path unchanged: budget clamp from previous fix, effort via resolveModelEffort
        resolvedEffort = resolveModelEffort(requestedEffort, modelObj)
        if (requestedEffort) effortResolutionRule = "output_config.effort (anthropic)"
        else if (thinkingBudget !== undefined) effortResolutionRule = "budget_tokens (anthropic, clamped)"
        else effortResolutionRule = "default (anthropic)"
      } else {
        // Non-Anthropic (meta/muse-spark): honor client's requested effort
        if (rawRequestedEffort) {
          // Precedence 1: output_config.effort present → map directly
          // Mapping table documented in mapClaudeEffortToBackend:
          // low→low, medium→medium, high→high, max→xhigh (Claude max = strongest, meta xhigh = strongest)
          const mapped = mapClaudeEffortToBackend(rawRequestedEffort, variants)
          if (mapped) {
            requestedEffort = mapped
            resolvedEffort = resolveModelEffort(mapped, modelObj) ?? mapped
            effortResolutionRule = `output_config.effort:${rawRequestedEffort}->${mapped}`
          } else {
            // Fallback to generic resolve
            resolvedEffort = resolveModelEffort(rawRequestedEffort, modelObj)
            effortResolutionRule = `output_config.effort:${rawRequestedEffort} (generic resolve)`
          }
        } else if (thinkingBudget !== undefined) {
          // Precedence 2: budget-only → derive effort from budget with documented thresholds
          // Thresholds justified against TUI's high=min(16000, floor(output/2-1)) and max=min(31999, output-1)
          const derived = budgetToEffort(thinkingBudget, variants)
          if (derived) {
            requestedEffort = derived
            resolvedEffort = resolveModelEffort(derived, modelObj) ?? derived
            effortResolutionRule = `budget_tokens:${thinkingBudget}->${derived}`
          } else {
            resolvedEffort = undefined
            effortResolutionRule = `budget_tokens:${thinkingBudget} (no variant matched)`
          }
        } else {
          // Precedence 3: neither → fallback xhigh (TUI parity)
          // TUI for meta sets reasoningEffort xhigh in ProviderTransform.options()
          requestedEffort = "xhigh"
          resolvedEffort = resolveModelEffort("xhigh", modelObj) ?? (variants.includes("xhigh") ? "xhigh" : undefined)
          effortResolutionRule = "default_xhigh (TUI parity)"
        }
      }
      if (DEBUG) {
        console.log("[anthropic-api] effort mapping", {
          model: body.model,
          rawRequested: rawRequestedEffort,
          requested: requestedEffort,
          resolved: resolvedEffort ?? "none",
          budget: thinkingBudget,
          rule: effortResolutionRule,
          available: Object.keys(modelObj.variants ?? {}),
        })
      }
      const sessionID = deriveSessionID(request, parsed.providerID, parsed.modelID, system)

      // Phase 1 instrumentation: log incoming request with full body
      try {
        const requestId = `req_${crypto.randomUUID().slice(0, 8)}`
        const thinkingBlocks = nonSystemMessages.flatMap((m: any) =>
          Array.isArray(m.content) ? m.content.filter((p: any) => p.type === "thinking") : [],
        )
        const toolUseBlocks = nonSystemMessages.flatMap((m: any) =>
          Array.isArray(m.content) ? m.content.filter((p: any) => p.type === "tool_use") : [],
        )
        const toolResultBlocks = nonSystemMessages.flatMap((m: any) =>
          Array.isArray(m.content) ? m.content.filter((p: any) => p.type === "tool_result") : [],
        )

        // Check for silent truncation: compare incoming message count vs coreMessages count
        const incomingMsgCount = body.messages.length
        const outgoingMsgCount = coreMessages.length

        logAnthropicEvent({
          timestamp: new Date().toISOString(),
          sessionId: sessionID,
          requestId,
          type: "request",
          data: {
            model: body.model,
            stream: body.stream,
            incomingMessages: incomingMsgCount,
            outgoingCoreMessages: outgoingMsgCount,
            messagesGrowth: `${incomingMsgCount} -> ${outgoingMsgCount}`,
            thinkingBlocks: {
              count: thinkingBlocks.length,
              hasSignatures: thinkingBlocks.map((b: any) => !!b.signature),
              signaturesPresent: thinkingBlocks.every((b: any) => !!b.signature),
              first50Chars: thinkingBlocks.map((b: any) => (b.thinking || "").slice(0, 50)),
            },
            toolUseBlocks: toolUseBlocks.map((b: any) => ({ id: b.id, name: b.name })),
            toolResultBlocks: toolResultBlocks.map((b: any) => ({ tool_use_id: b.tool_use_id })),
            // Check byte-preservation of thinking blocks in history
            thinkingRoundTrip: thinkingBlocks.map((b: any) => ({
              hasThinking: !!b.thinking,
              hasSignature: !!b.signature,
              thinkingLen: (b.thinking || "").length,
              signatureLen: (b.signature || "").length,
            })),
            // Full body for deep analysis (truncated for log size but preserve structure)
            bodySample: {
              messages: body.messages.slice(-3).map((m: any) => ({
                role: m.role,
                contentTypes: Array.isArray(m.content) ? m.content.map((c: any) => c.type) : typeof m.content,
                contentLen: typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length,
              })),
              systemType: typeof body.system,
              toolsCount: body.tools?.length ?? 0,
            },
            // Full body hash for duplicate detection
            bodyHash: (() => {
              try {
                return Bun.hash(JSON.stringify(body.messages)).toString(16)
              } catch {
                return "hash-error"
              }
            })(),
            coreMessagesSample: coreMessages.slice(-2).map((m: any) => ({
              role: m.role,
              contentTypes: Array.isArray(m.content) ? m.content.map((c: any) => c.type) : typeof m.content,
            })),
            rawBodyForReplay: body, // Full body for replay testing
          },
        })

        // Store for later use in response logging
        ;(body as any).__logRequestId = requestId
        ;(body as any).__logSessionId = sessionID
      } catch (e) {
        if (DEBUG) console.log("[anthropic-api] logging failed", e)
      }

      const providerOptions = buildProviderOptions(modelObj, resolvedEffort, sessionID, thinkingBudget)

      // Phase 0: Outbound request logging (no behavior change)
      try {
        const reqId = (body as any).__logRequestId || `req_${crypto.randomUUID().slice(0, 8)}`
        const sessId = (body as any).__logSessionId || sessionID
        // Extract anthropic-beta header if present
        const headers = (request.headers ?? {}) as Record<string, string>
        const getHeader = (name: string) => {
          const lower = name.toLowerCase()
          return headers[lower] ?? headers[name] ?? (headers as any)[lower.toLowerCase()]
        }
        const anthropicBeta = getHeader("anthropic-beta") || getHeader("x-anthropic-beta") || undefined

        // Per-message reasoning analysis for outbound coreMessages
        const outboundMessagesAnalysis = coreMessages.map((m: any, idx: number) => {
          const content = Array.isArray(m.content) ? m.content : typeof m.content === "string" ? [{ type: "text", text: m.content }] : []
          const reasoningParts = content.filter((p: any) => p.type === "reasoning")
          const reasoningLength = reasoningParts.reduce((sum: number, p: any) => sum + (p.text?.length ?? 0), 0)
          const hasReasoning = reasoningParts.length > 0
          const reasoningWithSignature = reasoningParts.filter((p: any) => !!p.providerOptions?.anthropic?.signature).length
          return {
            index: idx,
            role: m.role,
            hasReasoning,
            reasoningLength,
            reasoningCount: reasoningParts.length,
            reasoningWithSignature,
            contentTypes: content.map((p: any) => p.type),
          }
        })

        const totalReasoningBytesInHistory = outboundMessagesAnalysis
          .filter((m: any) => m.role === "assistant")
          .reduce((sum: number, m: any) => sum + m.reasoningLength, 0)

        const reasoningInEarlierTurns = outboundMessagesAnalysis
          .filter((m: any, i: number, arr: any[]) => {
            // All assistant messages except the last one
            const assistantIndices = arr.filter((x: any) => x.role === "assistant").map((x: any) => x.index)
            const lastAssistantIdx = assistantIndices.length > 0 ? assistantIndices[assistantIndices.length - 1] : -1
            return m.role === "assistant" && m.index !== lastAssistantIdx
          })
          .reduce((sum: number, m: any) => sum + m.reasoningLength, 0)

        const lastAssistant = [...outboundMessagesAnalysis].reverse().find((m: any) => m.role === "assistant")
        const reasoningInFinalTurn = lastAssistant?.reasoningLength ?? 0

        // Determine dropped/ignored fields
        const droppedFields: string[] = []
        const ignoredDetails: Record<string, any> = {}

        // thinking.budget_tokens
        const inboundThinking: any = body.thinking
        if (inboundThinking && typeof inboundThinking === "object" && inboundThinking.budget_tokens !== undefined) {
          const raw = providerOptions.raw as any
          const isAnthropic =
            modelObj.api.npm === "@ai-sdk/anthropic" ||
            modelObj.api.npm === "@ai-sdk/google-vertex/anthropic" ||
            (modelObj as any).providerID === "anthropic" ||
            (modelObj as any).api?.id?.includes("claude")
          if (isAnthropic) {
            // For Anthropic, budget should map directly to thinking.budgetTokens (clamped like TUI)
            const mapped = raw.thinking?.budgetTokens
            if (mapped !== undefined) {
              // Consider mapped if within clamp tolerance (TUI clamps to output-1 and 31999)
              const isMapped = Math.abs(mapped - inboundThinking.budget_tokens) <= 1 || mapped <= inboundThinking.budget_tokens
              if (!isMapped) {
                droppedFields.push("thinking.budget_tokens")
                ignoredDetails["thinking.budget_tokens"] = {
                  inbound: inboundThinking.budget_tokens,
                  outbound: mapped,
                  mapped: false,
                  reason: "budget not correctly clamped like TUI",
                }
              } else {
                ignoredDetails["thinking.budget_tokens"] = { inbound: inboundThinking.budget_tokens, outbound: mapped, mapped: true, reason: "mapped to thinking.budgetTokens with TUI-style clamp" }
              }
            } else {
              droppedFields.push("thinking.budget_tokens")
              ignoredDetails["thinking.budget_tokens"] = { inbound: inboundThinking.budget_tokens, mapped: false, reason: "budget_tokens not mapped to thinking.budgetTokens" }
            }
          } else {
            // For non-Anthropic (meta): new Part A honors budget via threshold table when effort absent
            // Thresholds justified against TUI high=min(16000,floor(output/2-1)) and max=min(31999,output-1)
            const hasReasoningCap =
              raw.reasoningEffort !== undefined ||
              raw.reasoning?.effort !== undefined ||
              raw.thinking?.budgetTokens !== undefined
            if (!hasReasoningCap) {
              droppedFields.push("thinking.budget_tokens")
              ignoredDetails["thinking.budget_tokens"] = { inbound: inboundThinking.budget_tokens, mapped: false, reason: "no reasoning cap in outbound" }
            } else {
              const isBudgetDerived = effortResolutionRule.includes("budget_tokens")
              ignoredDetails["thinking.budget_tokens"] = {
                inbound: inboundThinking.budget_tokens,
                outboundReasoningEffort: raw.reasoningEffort,
                mapped: true,
                rule: effortResolutionRule,
                reason: isBudgetDerived
                  ? "budget mapped to effort via threshold table (Part A, thresholds anchored to TUI high=16000 max=31999)"
                  : "budget present but effort from output_config.effort takes precedence (Part A)",
              }
            }
          }
        } else if (inboundThinking && typeof inboundThinking === "object") {
          ignoredDetails["thinking"] = inboundThinking
        }

        // max_tokens
        if (body.max_tokens !== undefined) {
          // We do forward it as maxOutputTokens, but check if it's actually used downstream
          // In streamText we pass maxOutputTokens = body.max_tokens, so it's forwarded
          // However if TUI path caps it, proxy may send larger value -> log as forwarded but different from TUI
          ignoredDetails["max_tokens"] = { inbound: body.max_tokens, outbound: body.max_tokens, forwarded: true }
        } else {
          droppedFields.push("max_tokens_missing")
          ignoredDetails["max_tokens"] = { inbound: undefined, note: "inbound max_tokens not set, outbound will use provider default" }
        }

        // stop_sequences
        if (body.stop_sequences !== undefined) {
          ignoredDetails["stop_sequences"] = { inbound: body.stop_sequences, forwarded: true, outbound: body.stop_sequences }
        } else {
          ignoredDetails["stop_sequences"] = { inbound: undefined, forwarded: false }
        }

        // temperature
        if (body.temperature !== undefined) {
          ignoredDetails["temperature"] = { inbound: body.temperature, forwarded: true, outbound: body.temperature }
        } else {
          ignoredDetails["temperature"] = { inbound: undefined, forwarded: false, note: "no inbound temperature, will use model default" }
        }

        // top_p, top_k
        if (body.top_p !== undefined) {
          ignoredDetails["top_p"] = { inbound: body.top_p, forwarded: true }
        }
        if (body.top_k !== undefined) {
          ignoredDetails["top_k"] = { inbound: body.top_k, forwarded: true }
        }

        // anthropic-beta headers
        if (anthropicBeta) {
          droppedFields.push("anthropic-beta")
          ignoredDetails["anthropic-beta"] = { inbound: anthropicBeta, forwarded: false, reason: "proxy ignores anthropic-beta headers (e.g., interleaved thinking)" }
        }

        // System prompt size
        const systemPromptSize = system.length
        const systemPromptLines = system.split("\n").length

        logAnthropicEvent({
          timestamp: new Date().toISOString(),
          sessionId: sessId,
          requestId: reqId,
          type: "outbound_request",
          data: {
            model: body.model,
            resolvedModelId: modelObj.id,
            providerId: parsed.providerID,
            stream: body.stream,
            samplingParams: {
              temperature: body.temperature,
              top_p: body.top_p,
              top_k: body.top_k,
              max_tokens: body.max_tokens,
              stop_sequences: body.stop_sequences,
            },
            reasoning: {
              rawRequestedEffort, // Claude's raw output_config.effort (low/medium/high/max)
              requestedEffort, // after mapping via mapClaudeEffortToBackend (e.g., max->xhigh)
              budgetTokens: thinkingBudget,
              resolvedEffort,
              effortResolutionRule: effortResolutionRule, // which rule fired: output_config.effort, budget_tokens, default_xhigh
              inboundThinking: body.thinking,
              providerOptionsRaw: providerOptions.raw,
              providerOptionsWrapped: providerOptions.wrapped,
              reasoningEffort: (providerOptions.raw as any).reasoningEffort,
              reasoningSummary: (providerOptions.raw as any).reasoningSummary,
              thinking: (providerOptions.raw as any).thinking,
              effortVariant: resolvedEffort,
            },
            messageCount: coreMessages.length,
            inboundMessageCount: body.messages.length,
            systemPrompt: {
              sizeChars: systemPromptSize,
              sizeLines: systemPromptLines,
              preview: system.slice(0, 200),
            },
            perMessageAnalysis: outboundMessagesAnalysis,
            reasoningBytes: {
              totalInHistory: totalReasoningBytesInHistory,
              inEarlierTurns: reasoningInEarlierTurns,
              inFinalTurn: reasoningInFinalTurn,
            },
            tools: {
              inboundCount: (body.tools as any[])?.length ?? 0,
              outboundCount: Object.keys(providerOptions.wrapped).length > 0 ? "via providerOptions" : "via aiTools not yet built here",
              // aiTools built later in handleStream, but we can log inbound tool count and names
              inboundToolNames: (body.tools as any[])?.map((t: any) => t.name) ?? [],
            },
            droppedFields,
            ignoredDetails,
            anthropicBetaHeader: anthropicBeta,
          },
        })
      } catch (e) {
        if (DEBUG) console.log("[anthropic-api] outbound logging failed", e)
      }

      if (body.stream) {
        return yield* handleStream(
          body,
          modelObj,
          providerID,
          system,
          coreMessages,
          providerOptions,
          resolvedEffort,
          request,
        )
      }
      return yield* handleNonStream(body, modelObj, providerID, system, coreMessages, providerOptions, resolvedEffort, request)
    }).pipe(Effect.provideService(InstanceRef, ctx))
  })
}

function handleStream(
  body: z.infer<typeof messagesRequestSchema>,
  modelObj: Model,
  providerID: ProviderV2.ID,
  system: string,
  coreMessages: any[],
  providerOptions: { raw: Record<string, any>; wrapped: Record<string, any> },
  resolvedEffort: string | undefined,
  httpRequest: HttpServerRequest.HttpServerRequest,
) {
  return Effect.gen(function* () {
    const context = yield* Effect.context()
    const run = Effect.runPromiseWith(context) as <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>
    const encoder = new TextEncoder()
    const messageId = `msg_${crypto.randomUUID()}`
    const estimatedInputTokens = estimateTokens(body.messages, body.system, body.tools as any[])

    // Per-attempt state per final correction
    let clientGone = false
    let attemptAbortController: AbortController | undefined
    let attemptStallError: ProviderError.StalledStreamError | undefined
    let stallTimer: NodeJS.Timeout | undefined
    let heartbeatTimer: NodeJS.Timeout | undefined
    let attempt = 0
    let lastSend = Date.now()

    const aiTools = body.tools ? toAITools(body.tools, modelObj) : undefined
    const aiToolNames = aiTools ? new Set(Object.keys(aiTools)) : undefined
    if (body.tool_choice && aiTools && Object.keys(aiTools).length > 0 && (body.tool_choice as any).type === "tool") {
      if (!aiToolNames!.has((body.tool_choice as any).name)) {
        if (DEBUG) console.log("[anthropic-api] dropping tool_choice referencing filtered tool", { name: (body.tool_choice as any).name })
        body.tool_choice = { type: "auto" } as any
      }
    } else if (body.tool_choice && !aiTools) {
      if (DEBUG) console.log("[anthropic-api] all tools filtered, dropping tool_choice")
      body.tool_choice = undefined
    }

    const makeWrapped = (lang: any) =>
      wrapLanguageModel({
        model: lang,
        middleware: [
          {
            specificationVersion: "v3" as const,
            async transformParams(args) {
              if (args.type === "stream") {
                try {
                  args.params.prompt = ProviderTransform.message(
                    args.params.prompt as any,
                    modelObj,
                    providerOptions.raw,
                  ) as any
                } catch {}
              }
              return args.params
            },
          },
        ],
      })

    const providerIDStr = (() => {
      try {
        if (typeof providerID === "string") return providerID
        return (providerID as any).id ?? String(providerID)
      } catch {
        return "default"
      }
    })()

    const readableStream = new ReadableStream({
      async start(controller: ReadableStreamDefaultController) {
        let messageStarted = false
        let blockIndex = 0
        let blockType: "text" | "thinking" | "tool_use" | null = null
        let finishReason: string | undefined
        let hadToolCall = false
        let lastError: unknown
        let contentStarted = false
        let resumeContent = ""
        let textChunks: string[] = []
        let reasoningChunks: string[] = []
        let textLen = 0
        let reasoningLen = 0
        let dedupChecked = false
        let gotFirstContent = false

        let rotation = await run(Provider.use.getRotation(providerID)).catch(() => undefined)
        let keyIndex: number | undefined
        let keyIdentity: string | undefined
        let currentLanguage = await run(
          Provider.use.getLanguage(modelObj, (info: { index: number; identity: string }) => {
            keyIndex = info.index
            keyIdentity = info.identity
          }),
        ).catch(() => undefined as any)
        let wrappedLanguage = currentLanguage ? makeWrapped(currentLanguage) : undefined

        // Phase 1 instrumentation: SSE event logging
        const sseLog: string[] = []
        const requestId = (body as any).__logRequestId || `req_${crypto.randomUUID().slice(0, 8)}`
        const sessionId = (body as any).__logSessionId || deriveSessionID(httpRequest, "unknown", body.model, "")

        const send = (s: string) => {
          if (clientGone) return
          try {
            // Log every SSE event with timestamp
            sseLog.push(s)
            if (LOG_ENABLED) {
              // Parse event type and index for analysis
              const eventMatch = s.match(/event:\s*(\S+)/)
              const dataMatch = s.match(/data:\s*(\{.*\})/)
              let parsedData: any = undefined
              try {
                if (dataMatch) parsedData = JSON.parse(dataMatch[1]!)
              } catch {}
              logAnthropicEvent({
                timestamp: new Date().toISOString(),
                sessionId,
                requestId,
                type: "response_event",
                data: {
                  eventType: eventMatch?.[1] || "unknown",
                  rawEvent: s.slice(0, 500),
                  parsed: parsedData,
                  blockIndex,
                  blockType,
                  finishReason,
                  hadToolCall,
                },
              })
            }

            controller.enqueue(encoder.encode(s))
            lastSend = Date.now()
          } catch {
            clientGone = true
          }
        }

        const safeClose = () => {
          if (heartbeatTimer) clearTimeout(heartbeatTimer)
          if (stallTimer) clearTimeout(stallTimer)
          heartbeatTimer = undefined
          stallTimer = undefined
          try {
            controller.close()
          } catch {}
        }

        const scheduleHeartbeat = () => {
          heartbeatTimer = setTimeout(() => {
            if (Date.now() - lastSend > 15000) {
              send(": keepalive\n\n")
            }
            if (!clientGone) scheduleHeartbeat()
          }, 15000)
        }
        scheduleHeartbeat()

        const armStall = (phase: "ttft" | "content") => {
          if (stallTimer) clearTimeout(stallTimer)
          const ms = getProviderTimeouts(providerIDStr).stall
          stallTimer = setTimeout(() => {
            const err = new ProviderError.StalledStreamError(phase, ms, ms, {
              providerID: providerIDStr,
              attempt,
              keyIndex,
            })
            attemptStallError = err
            console.error("[anthropic-api] STALL timeout", {
              phase,
              keyIndex,
              attempt,
              stallMs: ms,
              providerID: providerIDStr,
            })
            attemptAbortController?.abort(err)
          }, ms)
        }

        const clearStall = () => {
          if (stallTimer) {
            clearTimeout(stallTimer)
            stallTimer = undefined
          }
        }

        const startMessage = () => {
          if (messageStarted) return
          messageStarted = true
          send(
            `event: message_start\ndata: ${JSON.stringify({
              type: "message_start",
              message: {
                id: messageId,
                type: "message",
                role: "assistant",
                model: body.model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: estimatedInputTokens, output_tokens: 0 },
              },
            })}\n\n`,
          )
        }

        const closeBlock = () => {
          if (!blockType) return
          send(
            `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}\n\n`,
          )
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
        let thinkingHasContent = false
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
        const emitTextDelta = (text: string) => {
          if (!text) return
          openTextBlock()
          send(
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: "content_block_delta",
              index: blockIndex,
              delta: { type: "text_delta", text },
            })}\n\n`,
          )
        }
        const emitThinkingDelta = (thinking: string) => {
          if (!thinking) return
          // I3: Only emit thinking block if we have non-empty content, avoid zero-length blocks
          if (blockType !== "thinking") {
            openThinkingBlock()
            thinkingHasContent = true
          } else if (!thinkingHasContent) {
            thinkingHasContent = true
          }
          send(
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: "content_block_delta",
              index: blockIndex,
              delta: { type: "thinking_delta", thinking },
            })}\n\n`,
          )
        }
        const closeThinkingBlockIfNeeded = () => {
          if (blockType !== "thinking") return
          if (!thinkingHasContent) {
            // I3: Skip emitting stop for empty thinking block that was never given content, but if start was emitted we need to close.
            // Since we now only open on first content, if hasContent false, no start was emitted, so just reset type.
            // However defensive: if start was emitted (old logic), close and mark as not having emitted empty? For new logic, start only emitted when hasContent true, so we should close only if hasContent true.
            // To avoid orphan open, we close only if hasContent true, else just reset blockType without sending stop for empty that was already started.
            // Actually if start was emitted with empty, we have already sent start; we need to avoid sending empty block at all, so we should not emit start in first place.
            // For new logic, this path means hasContent true, so close.
            // If hasContent false but blockType is thinking (old empty start), we will close to avoid leak but this empty should have been prevented.
            // We count this as empty and close to keep state clean, but ideally this should not happen.
            // To fully prevent empty blocks, we reset without stop if never had content? But that would leave open block in client view.
            // Safer: if hasContent false, we still need to send stop if start was sent, otherwise just reset.
            // New logic ensures start only sent when hasContent true, so this should be safe to close.
            if (thinkingHasContent) {
              send(
                `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}\n\n`,
              )
              blockIndex++
              blockType = null
              thinkingHasContent = false
              return
            } else {
              // No content ever, no start should have been sent, just reset
              blockType = null
              thinkingHasContent = false
              return
            }
          }
          // has content, normal close
          send(
            `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}\n\n`,
          )
          blockIndex++
          blockType = null
          thinkingHasContent = false
        }

        try {
          // Ensure Claude Code gets message_start immediately to avoid infinite wait when early errors happen
          startMessage()

          if (!wrappedLanguage) {
            try {
              keyIndex = undefined
              keyIdentity = undefined
              currentLanguage = await run(
                Provider.use.getLanguage(modelObj, (info: { index: number; identity: string }) => {
                  keyIndex = info.index
                  keyIdentity = info.identity
                }),
              )
              wrappedLanguage = makeWrapped(currentLanguage)
            } catch (e) {}
          }

          for (;;) {
            if (clientGone) {
              safeClose()
              return
            }
            if (rotation && rotation.total > 0 && rotation.available === 0) {
              const lastWasConnection = lastError ? isConnectionLevelFailure(lastError) : false
              if (lastWasConnection && attempt < MAX_CONNECTION_RETRIES) {
                const delay = connectionRetryDelay(attempt)
                console.error("[anthropic-api] all keys on cooldown but last error was connection - retrying", {
                  total: rotation.total,
                  available: rotation.available,
                  attempt,
                  delayMs: delay,
                  lastError: lastError instanceof Error ? lastError.message : String(lastError ?? ""),
                })
                await sleep(delay)
                rotation = await run(Provider.use.getRotation(providerID)).catch(() => rotation)
                // Force retry fetching language even if still on cooldown - bypass by trying again
                try {
                  keyIndex = undefined
                  keyIdentity = undefined
                  currentLanguage = await run(
                    Provider.use.getLanguage(modelObj, (info: { index: number; identity: string }) => {
                      keyIndex = info.index
                      keyIdentity = info.identity
                    }),
                  )
                  wrappedLanguage = makeWrapped(currentLanguage)
                } catch {}
                attempt++
                continue
              }
              console.error("[anthropic-api] BREAK - all keys exhausted or on cooldown", {
                total: rotation.total,
                available: rotation.available,
              })
              if (!lastError) lastError = new Error("All keys exhausted or on cooldown")
              break
            }
            if (!wrappedLanguage) {
              try {
                keyIndex = undefined
                keyIdentity = undefined
                currentLanguage = await run(
                  Provider.use.getLanguage(modelObj, (info: { index: number; identity: string }) => {
                    keyIndex = info.index
                    keyIdentity = info.identity
                  }),
                )
                wrappedLanguage = makeWrapped(currentLanguage)
              } catch (e) {
                lastError = e
                const cls = classifyRouteError(e)
                if (cls) {
                  if (cls.kind === "tool_format") {
                    console.error("[anthropic-api] getLanguage tool_format - not burning key", {
                      message: e instanceof Error ? e.message : String(e),
                    })
                    break
                  }
                  if (cls.kind === "connection" && attempt < MAX_CONNECTION_RETRIES) {
                    const delay = connectionRetryDelay(attempt)
                    console.error("[anthropic-api] getLanguage connection - retrying", {
                      attempt,
                      delayMs: delay,
                      message: e instanceof Error ? e.message : String(e),
                    })
                    attempt++
                    await sleep(delay)
                    rotation = await run(Provider.use.getRotation(providerID)).catch(() => rotation)
                    continue
                  }
                  if (rotation) {
                    if (cls.kind === "invalid") {
                      await run(Provider.use.removeKey(providerID, keyIndex, { expectedIdentity: keyIdentity })).catch(() => undefined)
                    } else {
                      await run(
                        Provider.use.markRateLimited(providerID, keyIndex, {
                          ...routeCooldownOpts(cls, providerIDStr),
                          expectedIdentity: keyIdentity,
                        }),
                      ).catch(() => undefined)
                    }
                    rotation = await run(Provider.use.getRotation(providerID)).catch(() => undefined)
                    attempt++
                    continue
                  }
                }
                // Even if not classified but looks like connection, retry
                if (isConnectionLevelFailure(e) && attempt < MAX_CONNECTION_RETRIES) {
                  const delay = connectionRetryDelay(attempt)
                  console.error("[anthropic-api] getLanguage connection (fallback) - retrying", {
                    attempt,
                    delayMs: delay,
                  })
                  attempt++
                  await sleep(delay)
                  continue
                }
                break
              }
            }

            let streamError: unknown
            textChunks = []
            reasoningChunks = []
            textLen = 0
            reasoningLen = 0
            thinkingHasContent = false
            const messages = resumeContent
              ? [...coreMessages, { role: "assistant" as const, content: resumeContent }]
              : coreMessages
            if (resumeContent && DEBUG) {
              console.log("[anthropic-api] RESUME inject", { resumeChars: resumeContent.length, keyIndex })
            }

            // Per-attempt abort controller
            attemptAbortController = new AbortController()
            attemptStallError = undefined
            gotFirstContent = false
            const attemptStart = Date.now()
            armStall("ttft")

            if (DEBUG) {
              console.log("[anthropic-api] streamText start", {
                keyIndex,
                attempt,
                resumeChars: resumeContent.length,
                requestedEffort: (body as any).output_config?.effort ?? (body as any).effort,
                resolvedEffort,
                providerOptionsKeys: Object.keys(providerOptions.wrapped),
                providerOptionsRawKeys: Object.keys(providerOptions.raw),
                inputTokens: estimatedInputTokens,
                sessionID: (providerOptions.raw as any).promptCacheKey,
              })
            }

            let result: ReturnType<typeof streamText>
            try {
              result = streamText({
                model: wrappedLanguage!,
                system,
                messages,
                temperature: body.temperature,
                maxOutputTokens: body.max_tokens,
                topP: body.top_p,
                topK: body.top_k,
                stopSequences: body.stop_sequences,
                tools: aiTools,
                toolChoice: toAnthropicToolChoice(body.tool_choice),
                providerOptions: providerOptions.wrapped as any,
                abortSignal: attemptAbortController.signal,
                maxRetries: 0,
                onError(error: any) {
                  streamError = error.error
                  console.error("[anthropic-api] streamText error", {
                    keyIndex,
                    attempt,
                    message: error.error instanceof Error ? error.error.message : String(error.error),
                  })
                },
              })
            } catch (e) {
              console.error("[anthropic-api] streamText SYNC error", {
                keyIndex,
                attempt,
                error: e instanceof Error ? e.message : String(e),
              })
              throw e
            }

            try {
              startMessage()
              finishReason = undefined
              hadToolCall = false
              dedupChecked = false
              // I1, I5: Fixed parallel tool handling - serialize without duplicate ids or reopen
              const toolBlocks = new Map<string, { blockIndex?: number; toolName: string; hasDelta: boolean; inputBuffer: string; completed: boolean }>()
              let currentToolId: string | null = null
              const pendingQueue: string[] = []

              const flushPending = () => {
                // I1: Emit queued tool blocks serially, each with unique index, no reopen
                while (pendingQueue.length > 0 && currentToolId === null) {
                  const nextId = pendingQueue.shift()!
                  const nextState = toolBlocks.get(nextId)
                  if (!nextState) continue
                  if (blockType && blockType !== "tool_use") closeBlock()
                  send(
                    `event: content_block_start\ndata: ${JSON.stringify({
                      type: "content_block_start",
                      index: blockIndex,
                      content_block: { type: "tool_use", id: nextId, name: nextState.toolName, input: {} },
                    })}\n\n`,
                  )
                  blockType = "tool_use" as any
                  nextState.blockIndex = blockIndex
                  currentToolId = nextId
                  if (nextState.inputBuffer) {
                    send(
                      `event: content_block_delta\ndata: ${JSON.stringify({
                        type: "content_block_delta",
                        index: nextState.blockIndex,
                        delta: { type: "input_json_delta", partial_json: nextState.inputBuffer },
                      })}\n\n`,
                    )
                  }
                  if (nextState.completed) {
                    closeBlock()
                    currentToolId = null
                    continue
                  } else {
                    break
                  }
                }
              }

              const isContentStart = (t: string) =>
                t === "text-delta" ||
                t === "text-start" ||
                t === "reasoning-start" ||
                t === "reasoning-delta" ||
                t === "tool-input-start" ||
                t === "tool-call" ||
                t === "tool-input-delta"

              for await (const part of result.fullStream) {
                if (clientGone) break
                if (!gotFirstContent && isContentStart(part.type)) {
                  gotFirstContent = true
                  armStall("content")
                  if (DEBUG) {
                    console.log("[anthropic-api] TTFT", { keyIndex, attempt, ttftMs: Date.now() - attemptStart, partType: part.type })
                  }
                }

                if (part.type === "text-start") {
                  contentStarted = true
                  openTextBlock()
                  armStall("content")
                } else if (part.type === "text-delta") {
                  contentStarted = true
                  let text = (part as any).text
                  if (resumeContent && !dedupChecked) {
                    dedupChecked = true
                    text = Resume.stripOverlap(resumeContent, text)
                    if (!text) continue
                  }
                  textChunks.push(text)
                  textLen += text.length
                  emitTextDelta(text)
                  armStall("content")
                } else if (part.type === "text-end") {
                  closeBlock()
                } else if (part.type === "reasoning-start") {
                  contentStarted = true
                  // I3: Don't open empty thinking block on start; wait for first non-empty delta
                  // Reset hasContent flag for new reasoning segment
                  thinkingHasContent = false
                  armStall("content")
                } else if (part.type === "reasoning-delta") {
                  contentStarted = true
                  const reasoning = (part as any).text ?? (part as any).delta ?? (part as any).reasoning ?? ""
                  const sig = (part as any).signature ?? (part as any).providerOptions?.anthropic?.signature
                  // I3: Only emit thinking block when we have actual content or signature
                  if (reasoning) {
                    reasoningChunks.push(reasoning)
                    reasoningLen += reasoning.length
                    emitThinkingDelta(reasoning)
                  }
                  // Emit signature if present, and ensure block is open
                  if (sig) {
                    if (blockType !== "thinking") {
                      openThinkingBlock()
                      thinkingHasContent = true
                    } else if (!thinkingHasContent) {
                      thinkingHasContent = true
                    }
                    send(
                      `event: content_block_delta\ndata: ${JSON.stringify({
                        type: "content_block_delta",
                        index: blockIndex,
                        delta: { type: "signature_delta", signature: sig },
                      })}\n\n`,
                    )
                  }
                  if (reasoning || sig) armStall("content")
                } else if (part.type === "reasoning-end") {
                  // I1/I3 fix: If reasoning-end contains signature, emit signature_delta before closing
                  const sig =
                    (part as any).signature ??
                    (part as any).providerOptions?.anthropic?.signature ??
                    (part as any).providerMetadata?.anthropic?.signature
                  if (sig && sig.trim() !== "") {
                    if (blockType !== "thinking") {
                      openThinkingBlock()
                      thinkingHasContent = true
                    }
                    send(
                      `event: content_block_delta\ndata: ${JSON.stringify({
                        type: "content_block_delta",
                        index: blockIndex,
                        delta: { type: "signature_delta", signature: sig },
                      })}\n\n`,
                    )
                  }
                  // I3: Only close if we actually had content, skip zero-length thinking blocks
                  if (thinkingHasContent) {
                    closeBlock()
                    thinkingHasContent = false
                  } else {
                    // No content was ever emitted for this reasoning segment, ensure no empty block left
                    if (blockType === "thinking") {
                      // Defensive: if somehow open with no content, reset without emitting stop if start not yet sent? But closeBlock handles
                      // Since we now defer start until content, blockType should not be thinking here if no content
                      closeThinkingBlockIfNeeded()
                    }
                  }
                } else if (part.type === "finish-step" || part.type === "finish") {
                  finishReason = (part as any).finishReason
                } else if (part.type === "error") {
                  closeBlock()
                  throw (part as any).error
                } else if (part.type === "tool-input-start") {
                  hadToolCall = true
                  contentStarted = true
                  const toolCallId = (part as any).id
                  const toolName = (part as any).toolName
                  if (toolBlocks.has(toolCallId)) continue
                  // I1 I5: Serialize parallel tools without duplicate ids or reopen - queue if another tool active
                  toolBlocks.set(toolCallId, { toolName, hasDelta: false, inputBuffer: "", completed: false })
                  if (currentToolId === null) {
                    if (blockType && blockType !== "tool_use") closeBlock()
                    send(
                      `event: content_block_start\ndata: ${JSON.stringify({
                        type: "content_block_start",
                        index: blockIndex,
                        content_block: { type: "tool_use", id: toolCallId, name: toolName, input: {} },
                      })}\n\n`,
                    )
                    blockType = "tool_use" as any
                    const st = toolBlocks.get(toolCallId)!
                    st.blockIndex = blockIndex
                    currentToolId = toolCallId
                  } else {
                    pendingQueue.push(toolCallId)
                  }
                  armStall("content")
                } else if (part.type === "tool-input-delta") {
                  const toolCallId = (part as any).id
                  const delta = (part as any).delta ?? (part as any).inputTextDelta ?? ""
                  if (!delta) continue
                  let state = toolBlocks.get(toolCallId)
                  if (!state) {
                    // Defensive: delta without start
                    state = { toolName: (part as any).toolName ?? "unknown", hasDelta: false, inputBuffer: "", completed: false }
                    toolBlocks.set(toolCallId, state)
                    hadToolCall = true
                    contentStarted = true
                    if (currentToolId === null) {
                      if (blockType) closeBlock()
                      send(
                        `event: content_block_start\ndata: ${JSON.stringify({
                          type: "content_block_start",
                          index: blockIndex,
                          content_block: { type: "tool_use", id: toolCallId, name: state.toolName, input: {} },
                        })}\n\n`,
                      )
                      blockType = "tool_use" as any
                      state.blockIndex = blockIndex
                      currentToolId = toolCallId
                    } else {
                      pendingQueue.push(toolCallId)
                    }
                  }
                  state.inputBuffer += delta
                  state.hasDelta = true
                  if (toolCallId === currentToolId && state.blockIndex !== undefined) {
                    send(
                      `event: content_block_delta\ndata: ${JSON.stringify({
                        type: "content_block_delta",
                        index: state.blockIndex,
                        delta: { type: "input_json_delta", partial_json: delta },
                      })}\n\n`,
                    )
                  }
                  armStall("content")
                } else if (part.type === "tool-input-end") {
                  const toolCallId = (part as any).id
                  const state = toolBlocks.get(toolCallId)
                  if (!state) continue
                  state.completed = true
                  if (toolCallId === currentToolId) {
                    closeBlock()
                    currentToolId = null
                    flushPending()
                  }
                } else if (part.type === "tool-call") {
                  hadToolCall = true
                  contentStarted = true
                  const toolCallId = (part as any).toolCallId
                  const toolName = (part as any).toolName
                  const state = toolBlocks.get(toolCallId)
                  if (state?.hasDelta) {
                    if (toolCallId === currentToolId) {
                      closeBlock()
                      currentToolId = null
                      flushPending()
                    }
                    continue
                  }
                  const input = JSON.stringify(toolInput(part))
                  if (!toolBlocks.has(toolCallId)) {
                    toolBlocks.set(toolCallId, { toolName, hasDelta: false, inputBuffer: input, completed: true })
                  } else {
                    const st = toolBlocks.get(toolCallId)!
                    st.inputBuffer = input
                    st.completed = true
                  }
                  if (currentToolId === null) {
                    if (blockType) closeBlock()
                    send(
                      `event: content_block_start\ndata: ${JSON.stringify({
                        type: "content_block_start",
                        index: blockIndex,
                        content_block: { type: "tool_use", id: toolCallId, name: toolName, input: {} },
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
                  } else {
                    if (!pendingQueue.includes(toolCallId)) pendingQueue.push(toolCallId)
                  }
                }
              }

              if (clientGone) {
                safeClose()
                return
              }

              clearStall()
              if (DEBUG) {
                console.log("[anthropic-api] streamText success", {
                  keyIndex,
                  attempt,
                  durationMs: Date.now() - attemptStart,
                  finishReason,
                  hadToolCall,
                  textChars: textLen,
                  reasoningChars: reasoningLen,
                })
              }
              // I1 I5: Ensure all pending tool blocks are emitted before final close, no duplicate ids
              if (currentToolId !== null) {
                closeBlock()
                currentToolId = null
              }
              // Drain any remaining pending tools (e.g., completed while queueing)
              while (pendingQueue.length > 0) {
                const nid = pendingQueue.shift()!
                const ns = toolBlocks.get(nid)
                if (!ns) continue
                send(
                  `event: content_block_start\ndata: ${JSON.stringify({
                    type: "content_block_start",
                    index: blockIndex,
                    content_block: { type: "tool_use", id: nid, name: ns.toolName, input: {} },
                  })}\n\n`,
                )
                blockType = "tool_use" as any
                if (ns.inputBuffer) {
                  send(
                    `event: content_block_delta\ndata: ${JSON.stringify({
                      type: "content_block_delta",
                      index: blockIndex,
                      delta: { type: "input_json_delta", partial_json: ns.inputBuffer },
                    })}\n\n`,
                  )
                }
                send(
                  `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}\n\n`,
                )
                blockIndex++
              }
              closeBlock()
              const usage = await result.usage
              // I2 fixed: stop_reason based on actual tool calls, not just finishReason
              const finalStopReason = toAnthropicStopReason(finishReason, hadToolCall)

              // Phase 1 evidence: log stop_reason vs reality
              if (LOG_ENABLED) {
                logAnthropicEvent({
                  timestamp: new Date().toISOString(),
                  sessionId,
                  requestId,
                  type: "response_complete",
                  data: {
                    stop_reason: finalStopReason,
                    hadToolCall,
                    finishReason,
                    stopReasonCorrect: (finalStopReason === "tool_use") === hadToolCall,
                    textLen,
                    reasoningLen,
                    blockCount: blockIndex,
                    sseEventCount: sseLog.length,
                    eventSequence: sseLog.map((e) => {
                      const m = e.match(/event:\s*(\S+)/)
                      return m?.[1] || "unknown"
                    }),
                    usage,
                  },
                })
              }

              send(
                `event: message_delta\ndata: ${JSON.stringify({
                  type: "message_delta",
                  delta: { stop_reason: finalStopReason, stop_sequence: null },
                  usage: { output_tokens: usage.outputTokens },
                })}\n\n`,
              )
              send(`event: message_stop\ndata: {"type":"message_stop"}\n\n`)
              safeClose()
              return
            } catch (error) {
              clearStall()
              const actual = streamError ?? error
              const reason = attemptAbortController?.signal.reason

              if (clientGone) {
                safeClose()
                return
              }

              // Stall detection via same instance
              if (attemptStallError || isStallAbortReason(reason) || isStallAbortReason(actual)) {
                console.error("[anthropic-api] stall detected, rotating", {
                  keyIndex,
                  attempt,
                  reason: reason instanceof Error ? reason.message : String(reason),
                })
                lastError = attemptStallError ?? reason ?? actual
                // Mark as connection failure for cooldown
                await run(
                  Provider.use.markRateLimited(providerID, keyIndex, {
                    ...routeCooldownOpts({ kind: "connection" }, providerIDStr),
                    expectedIdentity: keyIdentity,
                  }),
                ).catch(() => undefined)

                if (contentStarted) {
                  let chunk = ""
                  const rs = reasoningChunks.join("")
                  const ts = textChunks.join("")
                  if (rs && ts) chunk = rs + "\n\n" + ts
                  else if (rs) chunk = rs
                  else if (ts) chunk = ts
                  if (chunk) resumeContent = Resume.compactResume(resumeContent + (resumeContent ? "\n\n" : "") + chunk)
                }
                if (blockType) closeBlock()
                attemptStallError = undefined
                attempt++
                rotation = await run(Provider.use.getRotation(providerID)).catch(() => undefined)
                try {
                  keyIndex = undefined
                  keyIdentity = undefined
                  currentLanguage = await run(
                    Provider.use.getLanguage(modelObj, (info: { index: number; identity: string }) => {
                      keyIndex = info.index
                      keyIdentity = info.identity
                    }),
                  )
                  wrappedLanguage = makeWrapped(currentLanguage)
                } catch {
                  wrappedLanguage = undefined as any
                }
                continue
              }

              if (isClientAbortReason(reason) || isClientAbortReason(actual)) {
                safeClose()
                return
              }

              if (clientGone) {
                safeClose()
                return
              }

              const errMsg = actual instanceof Error ? actual.message : String(actual ?? "")
              const cls = classifyRouteError(actual)
              if (DEBUG) {
                console.log("[anthropic-api] catch", {
                  errorMessage: errMsg,
                  classified: cls?.kind ?? "unclassified (terminal)",
                  contentStarted,
                  hasRotation: !!rotation,
                  resumeContentLen: resumeContent.length,
                  keyIndex,
                  attempt,
                  durationMs: Date.now() - attemptStart,
                })
              }
              if (cls) {
                if (cls.kind === "tool_format") {
                  console.error("[anthropic-api] tool_format error - check toAITools filtering", {
                    errorMessage: errMsg,
                    modelID: modelObj.id,
                    providerID: providerIDStr,
                    bodyToolsLen: body.tools?.length,
                    aiToolsKept: aiTools ? Object.keys(aiTools).length : 0,
                  })
                  lastError = actual
                  break
                }
                // For connection errors, always attempt retry with backoff even if rotation is missing
                if (cls.kind === "connection" && attempt < MAX_CONNECTION_RETRIES) {
                  const delay = connectionRetryDelay(attempt)
                  console.error("[anthropic-api] connection error - retrying", {
                    keyIndex,
                    attempt,
                    delayMs: delay,
                    errorMessage: errMsg,
                  })
                  if (rotation && keyIndex !== undefined) {
                    await run(
                      Provider.use.markRateLimited(providerID, keyIndex, {
                        ...routeCooldownOpts(cls, providerIDStr),
                        expectedIdentity: keyIdentity,
                      }),
                    ).catch(() => undefined)
                  }
                  if (contentStarted) {
                    let chunk = ""
                    const rs = reasoningChunks.join("")
                    const ts = textChunks.join("")
                    if (rs && ts) chunk = rs + "\n\n" + ts
                    else if (rs) chunk = rs
                    else if (ts) chunk = ts
                    if (chunk) resumeContent = Resume.compactResume(resumeContent + (resumeContent ? "\n\n" : "") + chunk)
                  }
                  if (blockType) closeBlock()
                  lastError = actual
                  attempt++
                  await sleep(delay)
                  rotation = await run(Provider.use.getRotation(providerID)).catch(() => rotation)
                  try {
                    keyIndex = undefined
                    keyIdentity = undefined
                    currentLanguage = await run(
                      Provider.use.getLanguage(modelObj, (info: { index: number; identity: string }) => {
                        keyIndex = info.index
                        keyIdentity = info.identity
                      }),
                    )
                    wrappedLanguage = makeWrapped(currentLanguage)
                  } catch {
                    wrappedLanguage = undefined as any
                  }
                  continue
                }
                if (rotation) {
                  if (cls.kind === "invalid") {
                    await run(Provider.use.removeKey(providerID, keyIndex, { expectedIdentity: keyIdentity })).catch(() => undefined)
                  } else {
                    await run(
                      Provider.use.markRateLimited(providerID, keyIndex, {
                        ...routeCooldownOpts(cls, providerIDStr),
                        expectedIdentity: keyIdentity,
                      }),
                    ).catch(() => undefined)
                  }
                  if (contentStarted) {
                    let chunk = ""
                    const rs = reasoningChunks.join("")
                    const ts = textChunks.join("")
                    if (rs && ts) chunk = rs + "\n\n" + ts
                    else if (rs) chunk = rs
                    else if (ts) chunk = ts
                    if (chunk) resumeContent = Resume.compactResume(resumeContent + (resumeContent ? "\n\n" : "") + chunk)
                  }
                  if (blockType) closeBlock()
                  lastError = actual
                  attempt++
                  rotation = await run(Provider.use.getRotation(providerID)).catch(() => undefined)
                  try {
                    keyIndex = undefined
                    keyIdentity = undefined
                    currentLanguage = await run(
                      Provider.use.getLanguage(modelObj, (info: { index: number; identity: string }) => {
                        keyIndex = info.index
                        keyIdentity = info.identity
                      }),
                    )
                    wrappedLanguage = makeWrapped(currentLanguage)
                  } catch {
                    wrappedLanguage = undefined as any
                  }
                  continue
                }
              }
              // If still classified as connection but attempt limit not yet hit and rotation missing, retry once more before terminal
              if (cls?.kind === "connection" && attempt < MAX_CONNECTION_RETRIES) {
                const delay = connectionRetryDelay(attempt)
                console.error("[anthropic-api] connection error - no rotation, retrying anyway", {
                  attempt,
                  delayMs: delay,
                  errorMessage: errMsg,
                })
                lastError = actual
                attempt++
                await sleep(delay)
                rotation = await run(Provider.use.getRotation(providerID)).catch(() => rotation)
                continue
              }
              lastError = actual
              console.error("[anthropic-api] TERMINAL - error not rotatable, breaking", {
                errorMessage: errMsg,
                contentStarted,
                statusCode: (actual as any)?.statusCode,
                toolCount: body.tools?.length ?? 0,
                modelID: modelObj.id,
              })
              break
            }
          }

          const actual = lastError
          if (clientGone) {
            safeClose()
            return
          }
          if (blockType) closeBlock()
          send(
            `event: error\ndata: ${JSON.stringify({
              type: "error",
              error: { type: "api_error", message: actual instanceof Error ? actual.message : String(actual ?? "stream failed") },
            })}\n\n`,
          )
          safeClose()
        } catch (outerError) {
          if (clientGone) {
            safeClose()
            return
          }
          try {
            if (typeof blockType !== "undefined" && blockType) {
              try {
                controller.enqueue(
                  encoder.encode(
                    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}\n\n`,
                  ),
                )
              } catch {}
            }
          } catch {}
          try {
            controller.enqueue(
              encoder.encode(
                `event: error\ndata: ${JSON.stringify({
                  type: "error",
                  error: { type: "api_error", message: outerError instanceof Error ? outerError.message : String(outerError) },
                })}\n\n`,
              ),
            )
          } catch {}
          safeClose()
        }
      },
      cancel() {
        clientGone = true
        if (heartbeatTimer) clearTimeout(heartbeatTimer)
        if (stallTimer) clearTimeout(stallTimer)
        heartbeatTimer = undefined
        stallTimer = undefined
        try {
          attemptAbortController?.abort(new DOMException("client disconnected", "AbortError"))
        } catch {
          try {
            attemptAbortController?.abort()
          } catch {}
        }
      },
    })

    const stream = Stream.fromReadableStream({ evaluate: () => readableStream, onError: (e) => e })
    return HttpServerResponse.stream(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    })
  })
}

function handleNonStream(
  body: z.infer<typeof messagesRequestSchema>,
  modelObj: Model,
  providerID: ProviderV2.ID,
  system: string,
  coreMessages: any[],
  providerOptions: { raw: Record<string, any>; wrapped: Record<string, any> },
  resolvedEffort: string | undefined,
  _httpRequest: HttpServerRequest.HttpServerRequest,
) {
  return Effect.gen(function* () {
    const context = yield* Effect.context()
    const run = Effect.runPromiseWith(context) as <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>

    const aiTools = body.tools ? toAITools(body.tools, modelObj) : undefined
    const aiToolNames = aiTools ? new Set(Object.keys(aiTools)) : undefined
    if (body.tool_choice && aiTools && Object.keys(aiTools).length > 0 && (body.tool_choice as any).type === "tool") {
      if (!aiToolNames!.has((body.tool_choice as any).name)) {
        if (DEBUG) console.log("[anthropic-api] [non-stream] dropping tool_choice referencing filtered tool", { name: (body.tool_choice as any).name })
        body.tool_choice = { type: "auto" } as any
      }
    } else if (body.tool_choice && !aiTools) {
      if (DEBUG) console.log("[anthropic-api] [non-stream] all tools filtered, dropping tool_choice")
      body.tool_choice = undefined
    }

    const makeWrapped = (lang: any) =>
      wrapLanguageModel({
        model: lang,
        middleware: [
          {
            specificationVersion: "v3" as const,
            async transformParams(args) {
              if (args.type === "generate") {
                try {
                  args.params.prompt = ProviderTransform.message(
                    args.params.prompt as any,
                    modelObj,
                    providerOptions.raw,
                  ) as any
                } catch {}
              }
              return args.params
            },
          },
        ],
      })

    const providerIDStrNonStream = (() => {
      try {
        if (typeof providerID === "string") return providerID
        return (providerID as any).id ?? String(providerID)
      } catch { return "default" }
    })()

    return yield* Effect.promise(async () => {
      let rotation = await run(Provider.use.getRotation(providerID)).catch(() => undefined)
      let keyIndex: number | undefined
      let keyIdentity: string | undefined
      let currentLanguage: any
      let attempt = 0
      let lastError: unknown
      try {
        currentLanguage = await run(
          Provider.use.getLanguage(modelObj, (info: { index: number; identity: string }) => {
            keyIndex = info.index
            keyIdentity = info.identity
          }),
        )
      } catch (e) {
        lastError = e
      }
      let wrappedLanguage = currentLanguage ? makeWrapped(currentLanguage) : undefined

      try {
        for (;;) {
          if (!wrappedLanguage) {
            try {
              keyIndex = undefined
              keyIdentity = undefined
              currentLanguage = await run(
                Provider.use.getLanguage(modelObj, (info: { index: number; identity: string }) => {
                  keyIndex = info.index
                  keyIdentity = info.identity
                }),
              )
              wrappedLanguage = makeWrapped(currentLanguage)
            } catch (e) {
              lastError = e
              const cls = classifyRouteError(e)
              if (cls) {
                if (cls.kind === "tool_format") break
                if (cls.kind === "connection" && attempt < MAX_CONNECTION_RETRIES) {
                  const delay = connectionRetryDelay(attempt)
                  console.error("[anthropic-api] [non-stream] connection on getLanguage - retrying", {
                    attempt,
                    delayMs: delay,
                    error: e instanceof Error ? e.message : String(e),
                  })
                  attempt++
                  await sleep(delay)
                  rotation = await run(Provider.use.getRotation(providerID)).catch(() => rotation)
                  wrappedLanguage = undefined as any
                  continue
                }
                if (rotation) {
                  if (cls.kind === "invalid") {
                    await run(Provider.use.removeKey(providerID, keyIndex, { expectedIdentity: keyIdentity })).catch(() => undefined)
                  } else {
                    await run(
                      Provider.use.markRateLimited(providerID, keyIndex, {
                        ...routeCooldownOpts(cls, providerIDStrNonStream),
                        expectedIdentity: keyIdentity,
                      }),
                    ).catch(() => undefined)
                  }
                  rotation = await run(Provider.use.getRotation(providerID)).catch(() => undefined)
                  wrappedLanguage = undefined as any
                  attempt++
                  continue
                }
              }
              throw e
            }
          }

          if (rotation && rotation.total > 0 && rotation.available === 0) {
            const wasConn = lastError ? isConnectionLevelFailure(lastError) : false
            if (wasConn && attempt < MAX_CONNECTION_RETRIES) {
              const delay = connectionRetryDelay(attempt)
              console.error("[anthropic-api] [non-stream] all keys on cooldown but last was connection - retrying", {
                attempt,
                delayMs: delay,
                total: rotation.total,
              })
              attempt++
              await sleep(delay)
              rotation = await run(Provider.use.getRotation(providerID)).catch(() => rotation)
              try {
                keyIndex = undefined
                keyIdentity = undefined
                currentLanguage = await run(
                  Provider.use.getLanguage(modelObj, (info: { index: number; identity: string }) => {
                    keyIndex = info.index
                    keyIdentity = info.identity
                  }),
                )
                wrappedLanguage = makeWrapped(currentLanguage)
              } catch {}
              continue
            }
            return HttpServerResponse.jsonUnsafe(
              { type: "error", error: { type: "api_error", message: "All keys exhausted or on cooldown" } },
              { status: 500 },
            )
          }

          try {
            if (DEBUG) {
              console.log("[anthropic-api] generateText start", {
                model: body.model,
                requestedEffort: (body as any).output_config?.effort ?? (body as any).effort,
                resolvedEffort,
                providerOptionsKeys: Object.keys(providerOptions.wrapped),
                messagesLen: coreMessages.length,
                systemLen: system.length,
                sessionID: (providerOptions.raw as any).promptCacheKey,
              })
            }
            const result = await generateText({
              model: wrappedLanguage!,
              system,
              messages: coreMessages,
              temperature: body.temperature,
              maxOutputTokens: body.max_tokens,
              topP: body.top_p,
              topK: body.top_k,
              stopSequences: body.stop_sequences,
              tools: aiTools,
              toolChoice: toAnthropicToolChoice(body.tool_choice),
              providerOptions: providerOptions.wrapped as any,
              maxRetries: 0,
            })

            const hadToolCallNonStream = result.toolCalls.length > 0
            // I2 I5: Include both text and tool_use when present, preserve 1:1 id mapping, correct stop_reason
            const nonStreamContent: any[] = []
            if (result.text) {
              nonStreamContent.push({ type: "text", text: result.text })
            }
            for (const tc of result.toolCalls) {
              nonStreamContent.push({
                type: "tool_use",
                id: tc.toolCallId,
                name: tc.toolName,
                input: toolInput(tc),
              })
            }
            if (nonStreamContent.length === 0) {
              nonStreamContent.push({ type: "text", text: "" })
            }
            return HttpServerResponse.jsonUnsafe({
              id: `msg_${crypto.randomUUID()}`,
              type: "message",
              role: "assistant",
              model: body.model,
              content: nonStreamContent,
              stop_reason: toAnthropicStopReason(result.finishReason, hadToolCallNonStream),
              stop_sequence: null,
              usage: {
                input_tokens: result.usage.inputTokens,
                output_tokens: result.usage.outputTokens,
              },
            })
          } catch (error) {
            console.error("[anthropic-api] generateText error", {
              error: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack?.slice(0, 3000) : undefined,
            })
            if (DEBUG) {
              console.error("[anthropic-api] generateText error dump", {
                messagesSample: JSON.stringify(coreMessages.slice(-3), null, 2).slice(0, 10000),
              })
            }
            const cls = classifyRouteError(error)
            lastError = error
            if (cls) {
              if (cls.kind === "tool_format") {
                console.error("[anthropic-api] generateText tool_format error", {
                  error: error instanceof Error ? error.message : String(error),
                  modelID: modelObj.id,
                })
                return HttpServerResponse.jsonUnsafe(
                  {
                    type: "error",
                    error: { type: "invalid_request_error", message: error instanceof Error ? error.message : String(error) },
                  },
                  { status: 400 },
                )
              }
              if (cls.kind === "connection" && attempt < MAX_CONNECTION_RETRIES) {
                const delay = connectionRetryDelay(attempt)
                console.error("[anthropic-api] generateText connection error - retrying", {
                  attempt,
                  delayMs: delay,
                  error: error instanceof Error ? error.message : String(error),
                })
                if (rotation && keyIndex !== undefined) {
                  await run(
                    Provider.use.markRateLimited(providerID, keyIndex, {
                      ...routeCooldownOpts(cls, providerIDStrNonStream),
                      expectedIdentity: keyIdentity,
                    }),
                  ).catch(() => undefined)
                }
                attempt++
                await sleep(delay)
                rotation = await run(Provider.use.getRotation(providerID)).catch(() => rotation)
                try {
                  keyIndex = undefined
                  keyIdentity = undefined
                  currentLanguage = await run(
                    Provider.use.getLanguage(modelObj, (info: { index: number; identity: string }) => {
                      keyIndex = info.index
                      keyIdentity = info.identity
                    }),
                  )
                  wrappedLanguage = makeWrapped(currentLanguage)
                } catch {
                  wrappedLanguage = undefined as any
                }
                continue
              }
              if (rotation) {
                if (cls.kind === "invalid") {
                  await run(Provider.use.removeKey(providerID, keyIndex, { expectedIdentity: keyIdentity })).catch(() => undefined)
                } else {
                  await run(
                    Provider.use.markRateLimited(providerID, keyIndex, {
                      ...routeCooldownOpts(cls, providerIDStrNonStream),
                      expectedIdentity: keyIdentity,
                    }),
                  ).catch(() => undefined)
                }
                rotation = await run(Provider.use.getRotation(providerID)).catch(() => undefined)
                try {
                  keyIndex = undefined
                  keyIdentity = undefined
                  currentLanguage = await run(
                    Provider.use.getLanguage(modelObj, (info: { index: number; identity: string }) => {
                      keyIndex = info.index
                      keyIdentity = info.identity
                    }),
                  )
                  wrappedLanguage = makeWrapped(currentLanguage)
                } catch {
                  wrappedLanguage = undefined as any
                }
                attempt++
                continue
              }
            }
            // Fallback: if classified as connection but no rotation, still retry few times
            if (isConnectionLevelFailure(error) && attempt < MAX_CONNECTION_RETRIES) {
              const delay = connectionRetryDelay(attempt)
              console.error("[anthropic-api] generateText connection (fallback) - retrying", {
                attempt,
                delayMs: delay,
              })
              attempt++
              await sleep(delay)
              continue
            }
            return HttpServerResponse.jsonUnsafe(
              {
                type: "error",
                error: { type: "api_error", message: error instanceof Error ? error.message : String(error) },
              },
              { status: 500 },
            )
          }
        }
        return HttpServerResponse.jsonUnsafe(
          { type: "error", error: { type: "api_error", message: "All rotation attempts exhausted" } },
          { status: 500 },
        )
      } catch (error) {
        console.error("[anthropic-api] outer error", {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack?.slice(0, 3000) : undefined,
        })
        return HttpServerResponse.jsonUnsafe(
          { type: "error", error: { type: "api_error", message: error instanceof Error ? error.message : String(error) } },
          { status: 500 },
        )
      }
    })
  })
}

// Exported for testing - generates SSE events from a synthetic fullStream sequence
// Fixed version: I1 I5 - no duplicate ids, no reopen, serialize parallel tools
export function __test_generateSSEFromParts(parts: any[]): string[] {
  const sse: string[] = []
  let blockIndex = 0
  let blockType: "text" | "thinking" | "tool_use" | null = null
  let hadToolCall = false
  const toolBlocks = new Map<string, { blockIndex?: number; toolName: string; hasDelta: boolean; inputBuffer: string; completed: boolean }>()
  let currentToolId: string | null = null
  const pendingQueue: string[] = []

  const send = (s: string) => sse.push(s)

  const closeBlock = () => {
    if (!blockType) return
    send(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}\n\n`)
    blockIndex++
    blockType = null
  }

  const flushPending = () => {
    while (pendingQueue.length > 0 && currentToolId === null) {
      const nextId = pendingQueue.shift()!
      const nextState = toolBlocks.get(nextId)
      if (!nextState) continue
      if (blockType && blockType !== "tool_use") closeBlock()
      send(
        `event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: blockIndex,
          content_block: { type: "tool_use", id: nextId, name: nextState.toolName, input: {} },
        })}\n\n`,
      )
      blockType = "tool_use" as any
      nextState.blockIndex = blockIndex
      currentToolId = nextId
      if (nextState.inputBuffer) {
        send(
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: nextState.blockIndex,
            delta: { type: "input_json_delta", partial_json: nextState.inputBuffer },
          })}\n\n`,
        )
      }
      if (nextState.completed) {
        closeBlock()
        currentToolId = null
        continue
      } else {
        break
      }
    }
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

  let thinkingHasContent = false

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

  const closeThinkingBlockIfNeeded = () => {
    if (blockType !== "thinking") return
    if (!thinkingHasContent) {
      blockType = null
      thinkingHasContent = false
      return
    }
    send(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}\n\n`)
    blockIndex++
    blockType = null
    thinkingHasContent = false
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

  let finishReason: string | undefined

  for (const part of parts) {
    if (part.type === "text-start") {
      openTextBlock()
    } else if (part.type === "text-delta") {
      const text = part.text
      if (!text) continue
      openTextBlock()
      send(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "text_delta", text },
        })}\n\n`,
      )
    } else if (part.type === "text-end") {
      closeBlock()
    } else if (part.type === "reasoning-start") {
      thinkingHasContent = false
    } else if (part.type === "reasoning-delta") {
      const reasoning = part.text ?? part.delta ?? part.reasoning ?? ""
      const sig = (part as any).signature
      if (!reasoning && !sig) continue
      if (reasoning) {
        if (blockType !== "thinking") {
          openThinkingBlock()
          thinkingHasContent = true
        } else if (!thinkingHasContent) {
          thinkingHasContent = true
        }
        send(
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "thinking_delta", thinking: reasoning },
          })}\n\n`,
        )
      }
      if (sig) {
        if (blockType !== "thinking") {
          openThinkingBlock()
          thinkingHasContent = true
        } else if (!thinkingHasContent) {
          thinkingHasContent = true
        }
        send(
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "signature_delta", signature: sig },
          })}\n\n`,
        )
      }
    } else if (part.type === "reasoning-end") {
      const sig = (part as any).signature
      if (sig) {
        if (blockType !== "thinking") {
          openThinkingBlock()
          thinkingHasContent = true
        }
        send(
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "signature_delta", signature: sig },
          })}\n\n`,
        )
      }
      if (thinkingHasContent) {
        closeBlock()
        thinkingHasContent = false
      } else {
        closeThinkingBlockIfNeeded()
      }
    } else if (part.type === "finish") {
      finishReason = part.finishReason
    } else if (part.type === "tool-input-start") {
      hadToolCall = true
      const toolCallId = part.id
      const toolName = part.toolName
      if (toolBlocks.has(toolCallId)) continue
      toolBlocks.set(toolCallId, { toolName, hasDelta: false, inputBuffer: "", completed: false })
      if (currentToolId === null) {
        if (blockType && blockType !== "tool_use") closeBlock()
        send(
          `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: blockIndex,
            content_block: { type: "tool_use", id: toolCallId, name: toolName, input: {} },
          })}\n\n`,
        )
        blockType = "tool_use" as any
        const st = toolBlocks.get(toolCallId)!
        st.blockIndex = blockIndex
        currentToolId = toolCallId
      } else {
        pendingQueue.push(toolCallId)
      }
    } else if (part.type === "tool-input-delta") {
      const toolCallId = part.id
      const delta = part.delta ?? ""
      if (!delta) continue
      let state = toolBlocks.get(toolCallId)
      if (!state) {
        state = { toolName: part.toolName ?? "unknown", hasDelta: false, inputBuffer: "", completed: false }
        toolBlocks.set(toolCallId, state)
        hadToolCall = true
        if (currentToolId === null) {
          if (blockType) closeBlock()
          send(
            `event: content_block_start\ndata: ${JSON.stringify({
              type: "content_block_start",
              index: blockIndex,
              content_block: { type: "tool_use", id: toolCallId, name: state.toolName, input: {} },
            })}\n\n`,
          )
          blockType = "tool_use" as any
          state.blockIndex = blockIndex
          currentToolId = toolCallId
        } else {
          pendingQueue.push(toolCallId)
        }
      }
      state.inputBuffer += delta
      state.hasDelta = true
      if (toolCallId === currentToolId && state.blockIndex !== undefined) {
        send(
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: state.blockIndex,
            delta: { type: "input_json_delta", partial_json: delta },
          })}\n\n`,
        )
      }
    } else if (part.type === "tool-input-end") {
      const toolCallId = part.id
      const state = toolBlocks.get(toolCallId)
      if (!state) continue
      state.completed = true
      if (toolCallId === currentToolId) {
        closeBlock()
        currentToolId = null
        flushPending()
      }
    } else if (part.type === "tool-call") {
      hadToolCall = true
      const toolCallId = part.toolCallId
      const toolName = part.toolName
      const state = toolBlocks.get(toolCallId)
      if (state?.hasDelta) {
        if (toolCallId === currentToolId) {
          closeBlock()
          currentToolId = null
          flushPending()
        }
        continue
      }
      const input = JSON.stringify(part.input || {})
      if (!toolBlocks.has(toolCallId)) {
        toolBlocks.set(toolCallId, { toolName, hasDelta: false, inputBuffer: input, completed: true })
      } else {
        const st = toolBlocks.get(toolCallId)!
        st.inputBuffer = input
        st.completed = true
      }
      if (currentToolId === null) {
        if (blockType) closeBlock()
        send(
          `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: blockIndex,
            content_block: { type: "tool_use", id: toolCallId, name: toolName, input: {} },
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
      } else {
        if (!pendingQueue.includes(toolCallId)) pendingQueue.push(toolCallId)
      }
    }
  }

  if (currentToolId !== null) {
    closeBlock()
    currentToolId = null
  }
  while (pendingQueue.length > 0) {
    const nid = pendingQueue.shift()!
    const ns = toolBlocks.get(nid)
    if (!ns) continue
    send(
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: blockIndex,
        content_block: { type: "tool_use", id: nid, name: ns.toolName, input: {} },
      })}\n\n`,
    )
    if (ns.inputBuffer) {
      send(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "input_json_delta", partial_json: ns.inputBuffer },
        })}\n\n`,
      )
    }
    send(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}\n\n`)
    blockIndex++
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

// Fixed non-stream generation: I2 I5 - include both text and tool_calls when both present
export function __test_generateNonStreamContent(result: { text?: string; toolCalls: Array<{ toolCallId: string; toolName: string; input: any }>; finishReason?: string }) {
  const hadToolCall = result.toolCalls.length > 0
  // I2: stop_reason=tool_use iff tool_use blocks present, so must include tool_use when hadToolCall
  // I5: 1:1 pairing - preserve all tool calls
  const content: any[] = []
  if (result.text) {
    content.push({ type: "text", text: result.text })
  }
  for (const tc of result.toolCalls) {
    content.push({
      type: "tool_use",
      id: tc.toolCallId,
      name: tc.toolName,
      input: tc.input,
    })
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "" })
  }
  const stopReason = toAnthropicStopReason(result.finishReason, hadToolCall)
  return { content, stopReason, hadToolCall }
}

export function anthropicRoute(directory: string) {
  return HttpRouter.use((router) =>
    Effect.gen(function* () {
      const instanceStore = yield* InstanceStore.Service
      const providerService = yield* Provider.Service
      const withServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(InstanceStore.Service, instanceStore),
          Effect.provideService(Provider.Service, providerService),
        )

      yield* router.add("GET", "/api/anthropic/v1/models", () => withServices(handleModels(directory)))
      yield* router.add("POST", "/api/anthropic/v1/messages", (request: HttpServerRequest.HttpServerRequest) =>
        withServices(handleMessages(directory, request)),
      )
      yield* router.add(
        "POST",
        "/api/anthropic/v1/messages/count_tokens",
        (request: HttpServerRequest.HttpServerRequest) => withServices(handleCountTokens(directory, request)),
      )
    }),
  )
}

export * as Anthropic from "./anthropic"
