import { Context, Effect, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { generateText, jsonSchema, streamText, tool, wrapLanguageModel, type ToolSet } from "ai"
import { z } from "zod"
import { Provider, type Model } from "@/provider/provider"
import { InstanceStore } from "@/project/instance-store"
import { InstanceRef } from "@/effect/instance-ref"
import { Resume } from "@/session/resume"
import { AppRuntime } from "@/effect/app-runtime"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderTransform } from "@/provider/transform"
import { EffortUtil } from "@/util/effort"
import { mergeDeep } from "remeda"

const ROTATE_COOLDOWN_MS = 60_000
const CONNECTION_COOLDOWN_MS = 5_000
const STALL_TIMEOUT_MS = 120_000

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
  // Only stable session-affinity headers — x-request-id is per-request and would bust cache.
  // Keep order: explicit opencode session first, then generic session ids.
  const candidates = [
    getHeader("x-opencode-session"),
    getHeader("x-session-id"),
    getHeader("x-session-affinity"),
    getHeader("x-parent-session-id"),
    getHeader("anthropic-session-id"),
    getHeader("session-id"),
  ].filter(Boolean) as string[]
  if (candidates.length > 0) return candidates[0]!
  // Stable fallback per provider/model — system hash previously caused cache busts when
  // system prompt had dynamic parts. For 1M context windows we want max cache reuse.
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
  // Some clients send effort top-level or inside output_config
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
  const toolNameById = new Map<string, string>()
  for (const m of input) {
    if (typeof m.content !== "string") {
      for (const part of m.content) {
        if ((part as any).type === "tool_use") toolNameById.set((part as any).id, (part as any).name)
      }
    }
  }

  const result = input.flatMap((m): any[] => {
    const isSystem = m.role === "system"
    // System messages should have been merged upstream, but handle defensively
    if (isSystem) {
      const text = typeof m.content === "string" ? m.content : m.content.map((p: any) => p.text ?? p.thinking ?? "").join("\n")
      if (!text.trim()) return []
      // Return as system with string content (AI SDK requires string for system)
      return [{ role: "system", content: text }]
    }
    const role = m.role as any
    if (typeof m.content === "string") {
      // Ensure non-empty
      return [{ role, content: m.content || " " }]
    }
    const parts = m.content
      .map((part: any): any => {
        if (part.type === "text") return { type: "text", text: part.text ?? "" }
        if (part.type === "image") {
          return { type: "image", image: part.source.data, mimeType: part.source.media_type }
        }
        if (part.type === "tool_use") {
          return { type: "tool-call", toolCallId: part.id, toolName: part.name || "unknown_tool", input: part.input ?? {} }
        }
        if (part.type === "tool_result") {
          const resolvedName = toolNameById.get(part.tool_use_id) || (part as any).name || part.tool_use_id || "unknown_tool"
          let output: any
          try {
            const raw = toolResultOutput(part)
            if (raw.type === "text" || raw.type === "error-text") {
              output = { type: "text", value: raw.value || " " }
            } else if (raw.type === "content") {
              const text = raw.value
                .map((b: any) => (b.type === "text" ? b.text : b.type === "media" ? "[media]" : ""))
                .join("\n")
              output = { type: "text", value: text || " " }
            } else {
              output = { type: "text", value: String(raw.value ?? " ") }
            }
          } catch {
            output = { type: "text", value: " " }
          }
          return {
            type: "tool-result",
            toolCallId: part.tool_use_id || `tool_${Math.random().toString(36).slice(2)}`,
            toolName: resolvedName,
            output,
          }
        }
        return null
      })
      .filter(Boolean)

    if (parts.length === 0) return []

    if (m.role === "user" && parts.some((p: any) => p.type === "tool-result")) {
      const toolResults = parts.filter((p: any) => p.type === "tool-result")
      const rest = parts.filter((p: any) => p.type !== "tool-result")
      const messages: any[] = [{ role: "tool", content: toolResults }]
      if (rest.length > 0) messages.push({ role: "user", content: rest })
      return messages
    }

    if (parts.length === 0 && role === "assistant") {
      return [{ role, content: [{ type: "text", text: "" }] }]
    }

    return [{ role, content: parts }]
  })

  // Reorder: system messages must be first for AI SDK validation
  const systemMsgs = result.filter((m: any) => m.role === "system")
  const nonSystem = result.filter((m: any) => m.role !== "system")
  if (systemMsgs.length > 0) {
    const mergedSystem = systemMsgs.map((m: any) => (typeof m.content === "string" ? m.content : m.content.map((p: any) => p.text).join("\n"))).join("\n\n")
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

function toAnthropicToolChoice(input: any): any {
  if (!input) return undefined
  if (input.type === "auto") return "auto"
  if (input.type === "any") return "required"
  if (input.type === "tool") return { type: "tool", toolName: input.name }
  return undefined
}

function toAITools(input: any[] | undefined, model?: Model): ToolSet | undefined {
  if (!input || input.length === 0) return undefined
  const result: ToolSet = {}
  const isOpenAIResponses =
    model?.api.npm === "@ai-sdk/openai" ||
    model?.api.npm === "@ai-sdk/azure" ||
    model?.api.npm === "@ai-sdk/amazon-bedrock/mantle"
  const sorted = [...input].toSorted((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))
  for (const item of sorted) {
    const t = tool({
      description: item.description,
      inputSchema: jsonSchema(item.input_schema as any),
    }) as any
    // Parity with TUI request.ts:149-158 - OpenAI Responses family hardcodes strict:false
    if (isOpenAIResponses) t.strict = false
    result[item.name] = t
  }
  return result
}

function toolInput(toolCall: any): unknown {
  return toolCall.args ?? toolCall.input ?? {}
}

function systemText(system: string | any[] | undefined): string {
  if (!system) return ""
  if (typeof system === "string") return system
  return system.map((p: any) => (p.type === "text" ? p.text : "")).join("")
}

function estimateTokens(messages: MessageParam[], system?: string | any[]): number {
  let text = systemText(system)
  for (const m of messages) {
    if (typeof m.content === "string") {
      text += m.content
    } else {
      text += m.content.map((p: any) => (p.type === "text" ? p.text : "")).join("")
    }
  }
  return Math.ceil(text.length / 4)
}

function parseRequestedEffort(body: z.infer<typeof messagesRequestSchema>): string | undefined {
  const oc = (body as any).output_config?.effort
  if (typeof oc === "string" && oc.trim() !== "") return oc.trim().toLowerCase()
  const direct = (body as any).effort
  if (typeof direct === "string" && direct.trim() !== "") return direct.trim().toLowerCase()
  const thinking = body.thinking
  if (thinking && typeof thinking === "object") {
    // If thinking is adaptive with no explicit effort, default to high when enabled?
    // For now we don't infer from budget_tokens, let Claude's effort param handle it.
    // But if thinking is disabled, we should return "none" to disable reasoning.
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
  // Use shared util that does flexible mapping: exact match, then next stronger, then fallback to strongest.
  const resolved = EffortUtil.resolveEffort(requested, variants)
  if (resolved) return resolved
  // Additional flexible fallback for xhigh<->max mapping when util returns undefined due to unknown rank
  // Our EffortUtil already handles known ranks, but handle edge case where requested is unknown string.
  const lower = requested.toLowerCase()
  if (variants.includes(lower)) return lower
  // If requested is max and model has xhigh, map max->xhigh
  if (lower === "max" && variants.includes("xhigh")) return "xhigh"
  // If requested is xhigh and model has max but not xhigh, map xhigh->max (e.g. glm-5.2)
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
  const mergedBase = mergeDeep(mergeDeep(base, model.options ?? {}), effortVariant && model.variants?.[effortVariant] ? model.variants[effortVariant] : {}) as Record<string, any>

  // Ensure prompt caching works for all providers, including cloudflare-workers-ai.
  // TUI core runner sets { openai: { promptCacheKey } } universally for native runtime.
  // For AI SDK path, we need promptCacheKey in raw options so providerOptions mapping emits it
  // under the correct provider key (openai, cloudflare-workers-ai, etc).
  const withCache = {
    ...mergedBase,
    promptCacheKey: (mergedBase as any).promptCacheKey ?? sessionID,
    prompt_cache_key: (mergedBase as any).prompt_cache_key ?? sessionID,
  } as Record<string, any>

  // For gateway / openrouter compatibility, keep both forms
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

type RouteErrorKind = "ratelimit" | "exhausted" | "connection" | "invalid"
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
  const { statusCode, message } = apiErrorDetails(error)
  if (statusCode !== undefined) return false
  const msg = message.toLowerCase()
  return (
    msg.includes("stream ended without finish") ||
    msg.includes("econnreset") ||
    msg.includes("socket connection was closed") ||
    msg.includes("connection was closed unexpectedly") ||
    msg.includes("the connection was closed") ||
    msg.includes("sse stalled") ||
    msg.includes("aborted")
  )
}

export function classifyRouteError(error: unknown): RouteError | undefined {
  const { statusCode, message, body, headers } = apiErrorDetails(error)
  const lowerMessage = message.toLowerCase()
  const lowerBody = body.toLowerCase()
  const retryAfterMs = parseRetryAfterMs(headers)
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
  if (statusCode === 500 || statusCode === 502 || statusCode === 503) {
    return { kind: "ratelimit", retryAfterMs }
  }
  if (isConnectionLevelFailure(error)) {
    return { kind: "connection", retryAfterMs: CONNECTION_COOLDOWN_MS }
  }
  return undefined
}

function routeCooldownOpts(cls: RouteError): { retryAfterMs?: number; exhausted?: boolean } {
  if (cls.kind === "invalid") {
    return { retryAfterMs: 0 }
  }
  if (cls.kind === "exhausted") {
    const now = new Date()
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0))
    return { retryAfterMs: midnight.getTime() - now.getTime() }
  }
  if (cls.kind === "connection") {
    return { retryAfterMs: Math.max(cls.retryAfterMs ?? 0, CONNECTION_COOLDOWN_MS) }
  }
  return { retryAfterMs: Math.max(cls.retryAfterMs ?? 0, ROTATE_COOLDOWN_MS) }
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
      return HttpServerResponse.jsonUnsafe({ input_tokens: estimateTokens(body.messages, body.system) })
    }).pipe(Effect.provideService(InstanceRef, ctx))
  })
}

function handleMessages(directory: string, request: HttpServerRequest.HttpServerRequest) {
  return Effect.gen(function* () {
    const ctx = yield* InstanceStore.use.load({ directory })
    return yield* Effect.gen(function* () {
      const raw = yield* request.json
      // Log incoming request for debugging effort levels
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
      // Merge any messages with role "system" into top-level system string
      // AI SDK requires system messages to be first and string content only - having system after user causes
      // "Invalid prompt: The messages do not match the ModelMessage[] schema."
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
      if (requestedEffort) {
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
    const abortController = new AbortController()
    let clientGone = false
    let heartbeatInterval: ReturnType<typeof setInterval> | undefined
    let stallTimer: ReturnType<typeof setTimeout> | undefined
    const estimatedInputTokens = estimateTokens(body.messages, body.system)

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
        let partialReasoning = ""
        let partialText = ""
        let dedupChecked = false


        const send = (s: string) => {
          if (clientGone) return
          try {
            controller.enqueue(encoder.encode(s))
          } catch {
            clientGone = true
          }
        }
        const sendHeartbeat = () => {
          if (clientGone) return
          try {
            controller.enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`))
          } catch {
            clientGone = true
            if (heartbeatInterval) clearInterval(heartbeatInterval)
          }
        }
        const safeClose = () => {
          if (heartbeatInterval) clearInterval(heartbeatInterval)
          if (stallTimer) clearTimeout(stallTimer)
          try {
            controller.close()
          } catch {}
        }

        // Send SSE comment ping every 15s to keep connection alive through
        // proxies and prevent client-side idle timeouts during long thinking
        // or large context processing (fixes "The operation timed out" in Claude Code)
        heartbeatInterval = setInterval(sendHeartbeat, 15000)

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
          let attempt = 0
          for (;;) {
            if (clientGone) return
            const rotation = await run(Provider.use.getRotation(providerID)).catch(() => undefined)
            if (rotation && rotation.total > 0 && rotation.available === 0) {
              console.error("[anthropic-api] BREAK - all keys exhausted or on cooldown", {
                total: rotation.total,
                available: rotation.available,
              })
              if (!lastError) lastError = new Error("All keys exhausted or on cooldown")
              break
            }

            let keyIndex: number | undefined
            const language = await run(
              Provider.use.getLanguage(modelObj, (index: number) => {
                keyIndex = index
              }),
            )
            // Parity with TUI llm.ts: wrapLanguageModel with ProviderTransform.message middleware
            // This ensures surrogate sanitization, reasoning filtering, tool-id scrubbing, etc.
            const wrappedLanguage = wrapLanguageModel({
              model: language,
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

            let streamError: unknown
            partialReasoning = ""
            partialText = ""
            const messages = resumeContent
              ? [...coreMessages, { role: "assistant" as const, content: resumeContent }]
              : coreMessages
            if (resumeContent) {
              console.log("[anthropic-api] RESUME inject", {
                resumeChars: resumeContent.length,
                keyIndex,
              })
            }
            let result: ReturnType<typeof streamText>
            try {
              result = streamText({
                model: wrappedLanguage,
                system,
                messages,
                temperature: body.temperature,
                maxOutputTokens: body.max_tokens,
                topP: body.top_p,
                topK: body.top_k,
                stopSequences: body.stop_sequences,
                tools: toAITools(body.tools, modelObj),
                toolChoice: toAnthropicToolChoice(body.tool_choice),
                providerOptions: providerOptions.wrapped as any,
                abortSignal: abortController.signal,
                maxRetries: 0,
                onError(error: any) {
                  streamError = error.error
                  console.error("[anthropic-api] streamText error", {
                    keyIndex,
                    message: error.error instanceof Error ? error.error.message : String(error.error),
                  })
                },
              })
            } catch (e) {
              console.error("[anthropic-api] streamText SYNC error - messages dump", {
                keyIndex,
                error: e instanceof Error ? e.message : String(e),
                stack: e instanceof Error ? e.stack?.slice(0, 2000) : undefined,
                systemLen: system.length,
                messagesLen: messages.length,
                messagesSample: JSON.stringify(messages.slice(-5), null, 2).slice(0, 8000),
                coreMessagesSample: JSON.stringify(coreMessages.slice(-5), null, 2).slice(0, 8000),
                allMessages: JSON.stringify(messages, null, 2).slice(0, 20000),
              })
              throw e
            }

            const attemptStart = Date.now()
            let gotFirstContent = false
            if (stallTimer) clearTimeout(stallTimer)
            stallTimer = setTimeout(() => {
              if (!gotFirstContent) {
                console.error("[anthropic-api] STALL timeout - no content after 120s", { keyIndex, attempt })
                abortController.abort(new Error("SSE stalled - no content after 120s"))
              }
            }, STALL_TIMEOUT_MS)
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

            try {
              startMessage()
              finishReason = undefined
              hadToolCall = false
              dedupChecked = false
              // Incremental tool streaming state - parity with TUI ai-sdk.ts tool-input-delta handling
              const toolBlocks = new Map<string, { blockIndex: number; toolName: string; hasDelta: boolean }>()

              for await (const part of result.fullStream) {
                if (clientGone) break
                // TTFT for any first content including tool calls - fixes missing TTFT logs
                if (
                  !gotFirstContent &&
                  (part.type === "text-delta" ||
                    part.type === "text-start" ||
                    part.type === "reasoning-start" ||
                    part.type === "reasoning-delta" ||
                    part.type === "tool-input-start" ||
                    part.type === "tool-call" ||
                    part.type === "tool-input-delta")
                ) {
                  gotFirstContent = true
                  if (stallTimer) {
                    clearTimeout(stallTimer)
                    stallTimer = undefined
                  }
                  console.log("[anthropic-api] TTFT", {
                    keyIndex,
                    attempt,
                    ttftMs: Date.now() - attemptStart,
                    partType: part.type,
                  })
                }
                if (part.type === "text-start") {
                  contentStarted = true
                  openTextBlock()
                } else if (part.type === "text-delta") {
                  contentStarted = true
                  let text = (part as any).text
                  if (resumeContent && !dedupChecked) {
                    dedupChecked = true
                    text = Resume.stripOverlap(resumeContent, text)
                    if (!text) continue
                  }
                  partialText += text
                  emitTextDelta(text)
                } else if (part.type === "text-end") {
                  closeBlock()
                } else if (part.type === "reasoning-start") {
                  contentStarted = true
                  openThinkingBlock()
                } else if (part.type === "reasoning-delta") {
                  contentStarted = true
                  const reasoning = (part as any).text ?? (part as any).delta ?? (part as any).reasoning ?? ""
                  partialReasoning += reasoning
                  emitThinkingDelta(reasoning)
                } else if (part.type === "reasoning-end") {
                  closeBlock()
                } else if (part.type === "finish-step" || part.type === "finish") {
                  finishReason = (part as any).finishReason
                } else if (part.type === "error") {
                  closeBlock()
                  throw (part as any).error
                } else if (part.type === "tool-input-start") {
                  // Incremental tool streaming - TUI parity: emit block start immediately
                  hadToolCall = true
                  contentStarted = true
                  const toolCallId = (part as any).id
                  const toolName = (part as any).toolName
                  closeBlock()
                  send(
                    `event: content_block_start\ndata: ${JSON.stringify({
                      type: "content_block_start",
                      index: blockIndex,
                      content_block: {
                        type: "tool_use",
                        id: toolCallId,
                        name: toolName,
                        input: {},
                      },
                    })}\n\n`,
                  )
                  blockType = "tool_use" as any
                  toolBlocks.set(toolCallId, { blockIndex, toolName, hasDelta: false })
                  // blockIndex will be incremented on close
                } else if (part.type === "tool-input-delta") {
                  const toolCallId = (part as any).id
                  const delta = (part as any).delta ?? (part as any).inputTextDelta ?? ""
                  if (!delta) continue
                  let state = toolBlocks.get(toolCallId)
                  if (!state) {
                    // Fallback if start was missed - open block
                    closeBlock()
                    const toolName = (part as any).toolName ?? toolBlocks.get(toolCallId)?.toolName ?? "unknown"
                    send(
                      `event: content_block_start\ndata: ${JSON.stringify({
                        type: "content_block_start",
                        index: blockIndex,
                        content_block: {
                          type: "tool_use",
                          id: toolCallId,
                          name: toolName,
                          input: {},
                        },
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
                } else if (part.type === "tool-input-end") {
                  const toolCallId = (part as any).id
                  const state = toolBlocks.get(toolCallId)
                  if (state && blockType === "tool_use") {
                    closeBlock()
                  }
                } else if (part.type === "tool-call") {
                  hadToolCall = true
                  contentStarted = true
                  const toolCallId = (part as any).toolCallId
                  const toolName = (part as any).toolName
                  const state = toolBlocks.get(toolCallId)
                  if (state?.hasDelta) {
                    // Already streamed incrementally - just ensure block is closed
                    if (blockType) closeBlock()
                    continue
                  }
                  // Fallback: no incremental deltas - emit whole JSON as one delta (old behavior)
                  closeBlock()
                  const input = JSON.stringify(toolInput(part))
                  send(
                    `event: content_block_start\ndata: ${JSON.stringify({
                      type: "content_block_start",
                      index: blockIndex,
                      content_block: {
                        type: "tool_use",
                        id: toolCallId,
                        name: toolName,
                        input: {},
                      },
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
                    `event: content_block_stop\ndata: ${JSON.stringify({
                      type: "content_block_stop",
                      index: blockIndex,
                    })}\n\n`,
                  )
                  blockIndex++
                }
              }

              if (clientGone) {
                console.log("[anthropic-api] streamText ended - client gone during stream", {
                  keyIndex,
                  attempt,
                  durationMs: Date.now() - attemptStart,
                })
                return
              }

              if (stallTimer) {
                clearTimeout(stallTimer)
                stallTimer = undefined
              }
              console.log("[anthropic-api] streamText success", {
                keyIndex,
                attempt,
                durationMs: Date.now() - attemptStart,
                finishReason,
                hadToolCall,
                textChars: partialText.length,
                reasoningChars: partialReasoning.length,
              })
              closeBlock()
              const usage = await result.usage
              send(
                `event: message_delta\ndata: ${JSON.stringify({
                  type: "message_delta",
                  delta: {
                    stop_reason: toAnthropicStopReason(finishReason ?? (hadToolCall ? "tool-calls" : undefined)),
                    stop_sequence: null,
                  },
                  usage: { output_tokens: usage.outputTokens },
                })}\n\n`,
              )
              send(`event: message_stop\ndata: {"type":"message_stop"}\n\n`)
              safeClose()
              return
            } catch (error) {
              const actual = streamError ?? error
              const errMsg = actual instanceof Error ? actual.message : String(actual ?? "")
              if (clientGone || abortController.signal.aborted) {
                console.log("[anthropic-api] client disconnected - aborting silently", {
                  errorMessage: errMsg,
                  contentStarted,
                  keyIndex,
                  attempt,
                })
                return
              }
              const cls = classifyRouteError(actual)
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
              if (cls && rotation) {
                if (cls.kind === "invalid") {
                  await run(Provider.use.removeKey(providerID, keyIndex)).catch(() => undefined)
                } else {
                  await run(
                    Provider.use.markRateLimited(providerID, keyIndex, routeCooldownOpts(cls)),
                  ).catch(() => undefined)
                }
                if (contentStarted) {
                  const chunk = partialReasoning + (partialText ? "\n\n" + partialText : "")
                  if (chunk)
                    resumeContent = Resume.compactResume(resumeContent + (resumeContent ? "\n\n" : "") + chunk)
                }
                if (blockType) closeBlock()
                lastError = actual
                attempt++
                continue
              }
              lastError = actual
              console.error("[anthropic-api] TERMINAL - error not rotatable, breaking", {
                errorMessage: errMsg,
                contentStarted,
              })
              break
            }
          }

          const actual = lastError
          if (clientGone) return
          if (blockType) closeBlock()
          send(
            `event: error\ndata: ${JSON.stringify({
              type: "error",
              error: {
                type: "api_error",
                message: actual instanceof Error ? actual.message : String(actual ?? "stream failed"),
              },
            })}\n\n`,
          )
          safeClose()
        } catch (outerError) {
          if (clientGone) return
          if (blockType) closeBlock()
          send(
            `event: error\ndata: ${JSON.stringify({
              type: "error",
              error: {
                type: "api_error",
                message: outerError instanceof Error ? outerError.message : String(outerError),
              },
            })}\n\n`,
          )
          safeClose()
        }
      },
      cancel() {
        clientGone = true
        if (heartbeatInterval) clearInterval(heartbeatInterval)
        if (stallTimer) clearTimeout(stallTimer)
        abortController.abort()
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

    return yield* Effect.promise(async () => {
      try {
        for (;;) {
          const rotation = await run(Provider.use.getRotation(providerID)).catch(() => undefined)
          if (rotation && rotation.total > 0 && rotation.available === 0) {
            return HttpServerResponse.jsonUnsafe(
              { type: "error", error: { type: "api_error", message: "All keys exhausted or on cooldown" } },
              { status: 500 },
            )
          }

          let keyIndex: number | undefined
          const language = await run(
            Provider.use.getLanguage(modelObj, (index: number) => {
              keyIndex = index
            }),
          )
          const wrappedLanguage = wrapLanguageModel({
            model: language,
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

          try {
            console.log("[anthropic-api] generateText start", {
              model: body.model,
              requestedEffort: (body as any).output_config?.effort ?? (body as any).effort,
              resolvedEffort,
              providerOptionsKeys: Object.keys(providerOptions.wrapped),
              messagesLen: coreMessages.length,
              systemLen: system.length,
              sessionID: (providerOptions.raw as any).promptCacheKey,
            })
            const result = await generateText({
              model: wrappedLanguage,
              system,
              messages: coreMessages,
              temperature: body.temperature,
              maxOutputTokens: body.max_tokens,
              topP: body.top_p,
              topK: body.top_k,
              stopSequences: body.stop_sequences,
              tools: toAITools(body.tools, modelObj),
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
            console.error("[anthropic-api] generateText error - dump", {
              error: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack?.slice(0, 3000) : undefined,
              messagesSample: JSON.stringify(coreMessages.slice(-3), null, 2).slice(0, 10000),
            })
            const cls = classifyRouteError(error)
            if (cls && rotation) {
              if (cls.kind === "invalid") {
                await run(Provider.use.removeKey(providerID, keyIndex)).catch(() => undefined)
              } else {
                await run(Provider.use.markRateLimited(providerID, keyIndex, routeCooldownOpts(cls)))
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
