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
  if (systemMsgs.length > 0) {
    let mergedSystem = ""
    for (let i = 0; i < systemMsgs.length; i++) {
      const mm = systemMsgs[i]!
      const txt =
        typeof mm.content === "string" ? mm.content : (mm.content as any[]).map((p: any) => p.text).join("\n")
      if (!txt) continue
      mergedSystem = mergedSystem ? mergedSystem + "\n\n" + txt : txt
    }
    return [{ role: "system", content: mergedSystem }, ...nonSystem]
  }
  return result
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
): { raw: Record<string, any>; wrapped: Record<string, any> } {
  const base = ProviderTransform.options({
    model,
    sessionID,
    providerOptions: {},
  })
  const variantOpts =
    effortVariant && model.variants?.[effortVariant] ? (model.variants[effortVariant] as Record<string, any>) : {}
  const mergedBase = { ...base, ...(model.options ?? {}), ...variantOpts } as Record<string, any>
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

function toAnthropicStopReason(finishReason: string | undefined): string {
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
          : undefined
    const message = typeof e.message === "string" ? e.message : ""
    const body =
      typeof e.responseBody === "string"
        ? e.responseBody
        : e.data && typeof e.data === "object"
          ? JSON.stringify(e.data)
          : ""
    const headers =
      e.responseHeaders && typeof e.responseHeaders === "object"
        ? (e.responseHeaders as Record<string, string>)
        : undefined
    if (statusCode !== undefined || message || body) {
      return { statusCode, message, body, headers }
    }
  }
  return { message: error instanceof Error ? error.message : String(error), body: "" }
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

export function isConnectionLevelFailure(error: unknown): boolean {
  // Per final revision: never infer stall from fetch string. Stall is detected via
  // isStallAbortReason (instance check) + attemptStallError same-instance. This helper
  // only covers generic transport failures, not stall/timeout strings.
  if (error instanceof ProviderError.StalledStreamError) return true
  const { statusCode, message } = apiErrorDetails(error)
  if (statusCode !== undefined) return false
  const msg = message.toLowerCase()
  return (
    msg.includes("stream ended without finish") ||
    msg.includes("econnreset") ||
    msg.includes("socket connection was closed") ||
    msg.includes("connection was closed unexpectedly") ||
    msg.includes("the connection was closed") ||
    msg.includes("authentication service")
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
      const requestedEffort = parseRequestedEffort(body)
      const resolvedEffort = resolveModelEffort(requestedEffort, modelObj)
      if (requestedEffort && DEBUG) {
        console.log("[anthropic-api] effort mapping", {
          model: body.model,
          requested: requestedEffort,
          resolved: resolvedEffort ?? "none",
          available: Object.keys(modelObj.variants ?? {}),
        })
      }
      const sessionID = deriveSessionID(request, parsed.providerID, parsed.modelID, system)
      const providerOptions = buildProviderOptions(modelObj, resolvedEffort, sessionID)
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

        const send = (s: string) => {
          if (clientGone) return
          try {
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
          openThinkingBlock()
          send(
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: "content_block_delta",
              index: blockIndex,
              delta: { type: "thinking_delta", thinking },
            })}\n\n`,
          )
        }

        try {
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
                if (cls && rotation) {
                  if (cls.kind === "tool_format") {
                    console.error("[anthropic-api] getLanguage tool_format - not burning key", {
                      message: e instanceof Error ? e.message : String(e),
                    })
                    break
                  }
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
                break
              }
            }

            let streamError: unknown
            textChunks = []
            reasoningChunks = []
            textLen = 0
            reasoningLen = 0
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
              const toolBlocks = new Map<string, { blockIndex: number; toolName: string; hasDelta: boolean }>()

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
                  openThinkingBlock()
                  armStall("content")
                } else if (part.type === "reasoning-delta") {
                  contentStarted = true
                  const reasoning = (part as any).text ?? (part as any).delta ?? (part as any).reasoning ?? ""
                  reasoningChunks.push(reasoning)
                  reasoningLen += reasoning.length
                  emitThinkingDelta(reasoning)
                  armStall("content")
                } else if (part.type === "reasoning-end") {
                  closeBlock()
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
                  closeBlock()
                  send(
                    `event: content_block_start\ndata: ${JSON.stringify({
                      type: "content_block_start",
                      index: blockIndex,
                      content_block: { type: "tool_use", id: toolCallId, name: toolName, input: {} },
                    })}\n\n`,
                  )
                  blockType = "tool_use" as any
                  toolBlocks.set(toolCallId, { blockIndex, toolName, hasDelta: false })
                  armStall("content")
                } else if (part.type === "tool-input-delta") {
                  const toolCallId = (part as any).id
                  const delta = (part as any).delta ?? (part as any).inputTextDelta ?? ""
                  if (!delta) continue
                  let state = toolBlocks.get(toolCallId)
                  if (!state) {
                    closeBlock()
                    const toolName = (part as any).toolName ?? toolBlocks.get(toolCallId)?.toolName ?? "unknown"
                    send(
                      `event: content_block_start\ndata: ${JSON.stringify({
                        type: "content_block_start",
                        index: blockIndex,
                        content_block: { type: "tool_use", id: toolCallId, name: toolName, input: {} },
                      })}\n\n`,
                    )
                    blockType = "tool_use" as any
                    state = { blockIndex, toolName, hasDelta: false }
                    toolBlocks.set(toolCallId, state)
                  }
                  state.hasDelta = true
                  send(
                    `event: content_block_delta\ndata: ${JSON.stringify({
                      type: "content_block_delta",
                      index: state.blockIndex,
                      delta: { type: "input_json_delta", partial_json: delta },
                    })}\n\n`,
                  )
                  armStall("content")
                } else if (part.type === "tool-input-end") {
                  const toolCallId = (part as any).id
                  const state = toolBlocks.get(toolCallId)
                  if (state && blockType === "tool_use") closeBlock()
                } else if (part.type === "tool-call") {
                  hadToolCall = true
                  contentStarted = true
                  const toolCallId = (part as any).toolCallId
                  const toolName = (part as any).toolName
                  const state = toolBlocks.get(toolCallId)
                  if (state?.hasDelta) {
                    if (blockType) closeBlock()
                    continue
                  }
                  closeBlock()
                  const input = JSON.stringify(toolInput(part))
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
              closeBlock()
              const usage = await result.usage
              send(
                `event: message_delta\ndata: ${JSON.stringify({
                  type: "message_delta",
                  delta: { stop_reason: toAnthropicStopReason(finishReason ?? (hadToolCall ? "tool-calls" : undefined)), stop_sequence: null },
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
              if (cls && rotation) {
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
      try {
        currentLanguage = await run(
          Provider.use.getLanguage(modelObj, (info: { index: number; identity: string }) => {
            keyIndex = info.index
            keyIdentity = info.identity
          }),
        )
      } catch {}
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
              const cls = classifyRouteError(e)
              if (cls && rotation) {
                if (cls.kind === "tool_format") break
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
                continue
              }
              throw e
            }
          }

          if (rotation && rotation.total > 0 && rotation.available === 0) {
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

            return HttpServerResponse.jsonUnsafe({
              id: `msg_${crypto.randomUUID()}`,
              type: "message",
              role: "assistant",
              model: body.model,
              content: result.text
                ? [{ type: "text", text: result.text }]
                : result.toolCalls.map((tc) => ({
                    type: "tool_use",
                    id: tc.toolCallId,
                    name: tc.toolName,
                    input: toolInput(tc),
                  })),
              stop_reason: toAnthropicStopReason(result.finishReason),
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
            if (cls && rotation) {
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
