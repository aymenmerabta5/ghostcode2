import type { NamedError } from "@opencode-ai/core/util/error"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Clock, Duration, Effect, Schedule } from "effect"
import { iife } from "@/util/iife"
import { isRecord } from "@/util/record"

export type Err = ReturnType<NamedError["toObject"]>

export const GO_UPSELL_MESSAGE = "Free usage exceeded, subscribe to Go"
export const GO_UPSELL_URL = "https://opencode.ai/go"
export type RetryReason = "free_tier_limit" | "account_rate_limit" | (string & {})

export type Retryable = {
  message: string
  isRateLimit: boolean
  // Credit exhaustion is permanent-for-session and must be told apart from a transient 429.
  isExhaustion?: boolean
  // Server-advised backoff parsed from the HTTP Retry-After / retry-after-ms header.
  retryAfterMs?: number
  action?: {
    reason: RetryReason
    provider: string
    title: string
    message: string
    label: string
    link?: string
  }
}

export const RETRY_FIXED_DELAY = 500
export const MAX_RETRIES = 3
export const MAX_RETRIES_RATE_LIMIT = 20
// Transient connection drops rotate to the next key but only cool the dropped key briefly —
// never to UTC midnight. Long enough to force getNext() onto another key, short enough that a
// healthy key recovers quickly.
export const ROTATE_COOLDOWN_MS = 60_000
// Floor on the instant-rotate delay so a burst of failed keys stays rate-limit-friendly.
export const ROTATE_DELAY_FLOOR_MS = 50

// Cloudflare conveys backoff via HTTP headers (exposed on APIError.data.responseHeaders), not the
// message body. Headers are matched case-insensitively; retry-after is seconds, retry-after-ms is ms.
function parseRetryAfter(headers: Record<string, string> | undefined): number | undefined {
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

export function retryable(error: Err, provider: string): Retryable | undefined {
  // context overflow errors should not be retried
  if (SessionV1.ContextOverflowError.isInstance(error)) return undefined
  if (SessionV1.APIError.isInstance(error)) {
    const status = error.data.statusCode
    const body = error.data.responseBody ?? ""
    const msg = error.data.message ?? ""
    const lowerBody = body.toLowerCase()
    const lowerMsg = msg.toLowerCase()
    const retryAfterMs = parseRetryAfter(error.data.responseHeaders)

    // Credit exhaustion is permanent-for-session; check it BEFORE the transient rate-limit and
    // isRetryable gates — a Cloudflare "used up your" 429 may arrive with isRetryable=false.
    if (lowerBody.includes("used up your") || lowerMsg.includes("used up your")) {
      return { message: msg || "Key exhausted", isRateLimit: false, isExhaustion: true, retryAfterMs }
    }

    // Account-level limits arrive as 429 but are NOT key-rotatable; surface them as upsell
    // actions before the generic rate-limit short-circuit claims them.
    if (body.includes("FreeUsageLimitError")) {
      return {
        message: GO_UPSELL_MESSAGE,
        isRateLimit: false,
        action: {
          reason: "free_tier_limit",
          provider,
          title: "Free limit reached",
          message:
            "Subscribe to OpenCode Go for reliable access to the best open-source models, starting at $5/month.",
          label: "subscribe",
          link: GO_UPSELL_URL,
        },
      }
    }
    if (body.includes("GoUsageLimitError")) {
      const parsed = parseJSON(body)
      const workspace = str(parsed?.metadata?.workspace)
      const limitName = str(parsed?.metadata?.limitName)
      const retryAfter = num(error.data.responseHeaders?.["retry-after"])
      const resetIn = iife(() => {
        if (retryAfter === undefined) return ""
        const seconds = Math.max(0, Math.ceil(retryAfter))
        const days = Math.floor(seconds / 86_400)
        const hours = Math.floor((seconds % 86_400) / 3_600)
        const minutes = Math.ceil((seconds % 3_600) / 60)
        const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? "" : "s"}`

        if (days > 0) return hours > 0 ? `${unit(days, "day")} ${unit(hours, "hour")}` : unit(days, "day")
        if (hours > 0) return minutes > 0 ? `${unit(hours, "hour")} ${unit(minutes, "minute")}` : unit(hours, "hour")
        return minutes > 0 ? unit(minutes, "minute") : "less than a minute"
      })

      const message = `${limitName ? `${limitName} usage limit` : "Usage limit"} reached. It will reset in ${resetIn}. To continue using this model now, enable usage from your available balance`
      const link = `https://opencode.ai/workspace/${workspace}/go`
      return {
        message: `${message} - ${link}`,
        isRateLimit: false,
        action: {
          reason: "account_rate_limit",
          provider,
          title: "Go limit reached",
          message,
          label: "open settings",
          link,
        },
      }
    }

    const isRateLimit =
      status === 429 ||
      body.includes("rate_limit") ||
      body.includes("too_many_requests") ||
      lowerBody.includes("too many requests") ||
      lowerBody.includes("rate limit") ||
      lowerMsg.includes("too many requests") ||
      lowerMsg.includes("rate limit")
    if (isRateLimit) return { message: msg || "Rate Limited", isRateLimit: true, retryAfterMs }

    // Cloudflare Workers AI auth error: {"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}
    // The key is invalid — rotate to the next key.
    const parsedBody = parseJSON(body)
    if (parsedBody && typeof parsedBody === "object" && parsedBody.success === false && Array.isArray(parsedBody.errors)) {
      const firstErr = parsedBody.errors[0]
      if (firstErr && firstErr.code === 10000) {
        return { message: "Cloudflare authentication error — rotating key", isRateLimit: true }
      }
    }

    // 5xx errors and other transient failures are retried with a fixed delay.
    if (!error.data.isRetryable && !(status !== undefined && status >= 500)) return undefined
    return { message: msg.includes("Overloaded") ? "Provider is overloaded" : msg, isRateLimit: false }
  }

  const json = parseJSON(isRecord(error.data) ? error.data.message : undefined)
  if (json && typeof json === "object") {
    const code = typeof json.code === "string" ? json.code : ""

    if (json.type === "error" && json.error?.type === "too_many_requests") {
      return { message: "Too Many Requests", isRateLimit: true }
    }
    if (code.includes("exhausted") || code.includes("unavailable")) {
      return { message: "Provider is overloaded", isRateLimit: false }
    }
    if (json.type === "error" && typeof json.error?.code === "string" && json.error.code.includes("rate_limit")) {
      return { message: "Rate Limited", isRateLimit: true }
    }
    if (Array.isArray(json.errors) && json.errors.length > 0) {
      const firstError = json.errors[0]
      if (typeof firstError.message === "string") {
        const errMsg = firstError.message.toLowerCase()
        if (errMsg.includes("used up your")) {
          return { message: firstError.message, isRateLimit: false, isExhaustion: true }
        }
        if (errMsg.includes("rate limit") || errMsg.includes("too many requests")) {
          return { message: firstError.message, isRateLimit: true }
        }
        // Cloudflare Workers AI authentication error: {"code":10000,"message":"Authentication error"}
        // Key is invalid — exhaust it and rotate to the next key.
        if (firstError.code === 10000 && errMsg.includes("authentication error")) {
          return { message: "Cloudflare authentication error — rotating key", isRateLimit: true }
        }
      }
    }

    // Cloudflare Workers AI wraps auth errors as: {"success":false,"errors":[{"code":10000,...}]}
    if (json.success === false && Array.isArray(json.errors) && json.errors.length > 0) {
      const firstError = json.errors[0]
      if (firstError.code === 10000) {
        return { message: "Cloudflare authentication error — rotating key", isRateLimit: true }
      }
    }
  }

  // Check for rate limit patterns in plain text error messages
  const msg = isRecord(error.data) ? error.data.message : undefined
  if (typeof msg === "string") {
    const lower = msg.toLowerCase()
    if (lower.includes("used up your")) {
      return { message: msg, isRateLimit: false, isExhaustion: true }
    }
    if (
      lower.includes("rate increased too quickly") ||
      lower.includes("rate limit") ||
      lower.includes("too many requests")
    ) {
      return { message: msg, isRateLimit: true }
    }
    // Connection-level failures (content-aware stall, clean stream-end, socket close,
    // connection-closed, read/header timeouts) MUST be retryable so the policy proceeds
    // to rotate to another key. Without this they surface as non-retryable and the
    // session dies instead of rotating.
    if (
      lower.includes("sse stalled") ||
      lower.includes("no content within timeout") ||
      lower.includes("stream ended without finish") ||
      lower.includes("stream ended without content") ||
      lower.includes("sse read timed out") ||
      lower.includes("response headers timed out") ||
      lower.includes("econnreset") ||
      lower.includes("socket connection was closed") ||
      lower.includes("connection was closed unexpectedly") ||
      lower.includes("the connection was closed")
    ) {
      return { message: msg, isRateLimit: false }
    }
  }

  return undefined
}

function isRotateTrigger(error: Err) {
  const raw = (error.data ?? {}) as Record<string, unknown>
  const msg = typeof raw.message === "string" ? raw.message.toLowerCase() : ""
  // ECONNRESET is surfaced as an APIError with a metadata code; everything else (stall,
  // stream-end, socket close) is matched on the message regardless of error type.
  if (SessionV1.APIError.isInstance(error)) {
    if (error.data.metadata?.code === "ECONNRESET") return true
    // Cloudflare Workers AI auth error in responseBody triggers rotation
    const body = error.data.responseBody ?? ""
    if (body.includes("10000") && body.includes("Authentication error")) return true
  }
  return (
    msg.includes("stream ended without finish") ||
    msg.includes("stream ended without content") ||
    msg.includes("sse stalled") ||
    msg.includes("no content within timeout") ||
    msg.includes("sse read timed out") ||
    msg.includes("response headers timed out") ||
    msg.includes("econnreset") ||
    msg.includes("socket connection was closed") ||
    msg.includes("connection was closed unexpectedly") ||
    msg.includes("the connection was closed") ||
    msg.includes("cloudflare authentication error")
  )
}

function str(value: unknown) {
  if (value === undefined || value === null) return ""
  return String(value)
}

function num(value: unknown) {
  const parsed = Number.parseFloat(str(value))
  if (Number.isNaN(parsed)) return undefined
  return parsed
}

function parseJSON(value: unknown) {
  return iife(() => {
    try {
      if (typeof value !== "string") return undefined
      return JSON.parse(value)
    } catch {
      return undefined
    }
  })
}

export function policy(opts: {
  provider: string
  parse: (error: unknown) => Err
  set: (input: {
    attempt: number
    message: string
    next: number
    isRateLimit: boolean
    action?: Retryable["action"]
  }) => Effect.Effect<void>
  onRateLimited?: (info: { retryAfterMs?: number }) => void | Effect.Effect<void>
  onKeyExhausted?: (info: { exhausted?: boolean }) => void | Effect.Effect<void>
  canRotateKey?: () => Effect.Effect<boolean>

  delay?: (input: { attempt: number; isRateLimit: boolean }) => Effect.Effect<Duration.Duration>
  shouldContinue?: (input: { attempt: number; isRateLimit: boolean }) => Effect.Effect<boolean>
}) {
  return Schedule.fromStepWithMetadata(
    Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
      const error = opts.parse(meta.input)
      const result = retryable(error, opts.provider)
      if (!result) return Cause.done(meta.attempt)
      return Effect.gen(function* () {
        const canRotate = opts.canRotateKey ? yield* opts.canRotateKey() : false
        const rotateTrigger = canRotate && isRotateTrigger(error)
        // Stalls and stream-ends are treated as TRANSIENT, NOT permanent exhaustion. Reasoning
        // models have natural long pauses between reasoning bursts — a stall does NOT mean the
        // key is dead. Only explicit "used up your" errors are permanent. This prevents
        // false-positive stalls from burning healthy keys.
        const treatAsRateLimit = result.isRateLimit || result.isExhaustion || rotateTrigger
        const maxRetries = treatAsRateLimit ? MAX_RETRIES_RATE_LIMIT : MAX_RETRIES
        yield* Effect.logInfo("retry policy decision", {
          attempt: meta.attempt,
          message: result.message,
          isRateLimit: result.isRateLimit,
          isExhaustion: result.isExhaustion,
          rotateTrigger,
          treatAsRateLimit,
          canRotate,
          maxRetries,
        })
        if (meta.attempt > maxRetries) {
          const shouldContinue = opts.shouldContinue
            ? yield* opts.shouldContinue({ attempt: meta.attempt, isRateLimit: treatAsRateLimit })
            : false
          if (!shouldContinue) {
            return yield* Cause.done(meta.attempt)
          }
        }
        const now = yield* Clock.currentTimeMillis
        if (treatAsRateLimit) {
          if (result.isExhaustion) {
            const effect = opts.onKeyExhausted?.({ exhausted: true })
            if (effect && Effect.isEffect(effect)) yield* effect
          } else {
            const retryAfterMs = result.isRateLimit ? result.retryAfterMs : ROTATE_COOLDOWN_MS
            const effect = opts.onRateLimited?.({ retryAfterMs })
            if (effect && Effect.isEffect(effect)) yield* effect
          }
        }
        const baseWait = treatAsRateLimit ? 0 : RETRY_FIXED_DELAY
        const wait = opts.delay
          ? yield* opts.delay({ attempt: meta.attempt, isRateLimit: treatAsRateLimit })
          : Duration.millis(baseWait)
        // Floor instant-rotate bursts; the all-cooled path already returns >= 1s.
        const finalMs = treatAsRateLimit
          ? Math.max(Duration.toMillis(wait), ROTATE_DELAY_FLOOR_MS)
          : Duration.toMillis(wait)
        yield* opts.set({
          attempt: meta.attempt,
          message: result.message,
          next: now + finalMs,
          isRateLimit: treatAsRateLimit,
          action: result.action,
        })
        return [meta.attempt, Duration.millis(finalMs)] as [number, Duration.Duration]
      })
    }),
  )
}

export * as SessionRetry from "./retry"
