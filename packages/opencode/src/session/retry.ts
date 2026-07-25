import type { NamedError } from "@opencode-ai/core/util/error"
import { Cause, Clock, Duration, Effect, Schedule } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { iife } from "@/util/iife"

export type Err = ReturnType<NamedError["toObject"]>

export const GO_UPSELL_MESSAGE = "Free usage exceeded, subscribe to Go https://opencode.ai/go"
export const GO_UPSELL_URL = "https://opencode.ai/go"

export const RETRY_FIXED_DELAY = 500
export const MAX_RETRIES = 3
export const MAX_RETRIES_RATE_LIMIT = 20
export const ROTATE_COOLDOWN_MS = 60_000
export const ROTATE_DELAY_FLOOR_MS = 50

export type Retryable = {
  message: string
  isRateLimit: boolean
  isExhaustion?: boolean
  isInvalid?: boolean
  retryAfterMs?: number
}

function isBillingVerificationFailed(text: string): boolean {
  const lower = text.toLowerCase()
  return lower.includes("billing verification failed")
}

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

export function retryable(error: Err): Retryable | undefined {
  if (SessionV1.ContextOverflowError.isInstance(error)) return undefined
  // Serialized detection for StalledStreamError - must not rely on instanceof across APIError boundary
  const meta = (error.data as any)?.metadata as any
  if (meta?.code === "StalledStreamError") {
    return { message: (error.data as any)?.message ?? meta.code, isRateLimit: false }
  }
  if (SessionV1.APIError.isInstance(error)) {
    const data = error.data as any
    if ((data.metadata as any)?.code === "StalledStreamError") {
      return { message: data.message ?? (data.metadata as any).code, isRateLimit: false }
    }
    const status = data.statusCode as number | undefined
    const body = (data.responseBody ?? "") as string
    const msg = (data.message ?? "") as string
    const lowerBody = body.toLowerCase()
    const lowerMsg = msg.toLowerCase()
    const retryAfterMs = parseRetryAfter(data.responseHeaders as Record<string, string> | undefined)

    if (
      iife(() => {
        try {
          return JSON.parse(body)?.error?.code === "invalid_api_key"
        } catch {
          return false
        }
      })
    ) {
      return { message: msg || "Invalid API key", isRateLimit: false, isInvalid: true, retryAfterMs }
    }

    if (isBillingVerificationFailed(body) || isBillingVerificationFailed(msg)) {
      return { message: msg || body || "Billing verification failed", isRateLimit: false, isInvalid: true, retryAfterMs }
    }

    if (lowerBody.includes("used up your") || lowerMsg.includes("used up your")) {
      return { message: msg || "Key exhausted", isRateLimit: false, isExhaustion: true, retryAfterMs }
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
    if ((data.responseBody as string | undefined)?.includes("FreeUsageLimitError"))
      return { message: GO_UPSELL_MESSAGE, isRateLimit: false }
    if (!data.isRetryable && !(status !== undefined && status >= 500)) return undefined
    return { message: msg, isRateLimit: false }
  }

  const json = iife(() => {
    try {
      const data = error.data as any
      if (typeof data?.message === "string") {
        const parsed = JSON.parse(data.message)
        return parsed
      }
      return JSON.parse(data.message)
    } catch {
      return undefined
    }
  })
  if (json && typeof json === "object") {
    const code = typeof (json as any).code === "string" ? (json as any).code : ""

    if ((json as any).type === "error" && (json as any).error?.type === "too_many_requests") {
      return { message: "Too Many Requests", isRateLimit: true }
    }
    if ((json as any).error?.code === "invalid_api_key") {
      return {
        message: typeof (json as any).error.message === "string" ? (json as any).error.message : "Invalid API key",
        isRateLimit: false,
        isInvalid: true,
      }
    }
    if (code.includes("exhausted") || code.includes("unavailable")) {
      return { message: "Provider is overloaded", isRateLimit: false }
    }
    if (
      (json as any).type === "error" &&
      typeof (json as any).error?.code === "string" &&
      (json as any).error.code.includes("rate_limit")
    ) {
      return { message: "Rate Limited", isRateLimit: true }
    }
    if (Array.isArray((json as any).errors) && (json as any).errors.length > 0) {
      const firstError = (json as any).errors[0]
      if (typeof firstError.message === "string") {
        const errMsg = firstError.message.toLowerCase()
        if (isBillingVerificationFailed(firstError.message)) {
          return { message: firstError.message, isRateLimit: false, isInvalid: true }
        }
        if (errMsg.includes("used up your")) {
          return { message: firstError.message, isRateLimit: false, isExhaustion: true }
        }
        if (errMsg.includes("rate limit") || errMsg.includes("too many requests")) {
          return { message: firstError.message, isRateLimit: true }
        }
      }
    }
  }

  const msg = (error.data as any)?.message
  if (typeof msg === "string") {
    const lower = msg.toLowerCase()
    if (isBillingVerificationFailed(msg)) {
      return { message: msg, isRateLimit: false, isInvalid: true }
    }
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
    if (
      lower.includes("sse stalled") ||
      lower.includes("no content within timeout") ||
      lower.includes("stream ended without finish") ||
      lower.includes("econnreset") ||
      lower.includes("socket connection was closed") ||
      lower.includes("connection was closed unexpectedly") ||
      lower.includes("the connection was closed") ||
      lower.includes("timed out") ||
      lower.includes("timeout") ||
      lower.includes("service timeout") ||
      lower.includes("authentication service")
    ) {
      return { message: msg, isRateLimit: false }
    }
  }

  return undefined
}

function isRotateTrigger(error: Err) {
  const msg = typeof (error.data as any)?.message === "string" ? (error.data as any).message.toLowerCase() : ""
  const meta = (error.data as any)?.metadata as any
  if (meta?.code === "StalledStreamError") return true
  if (meta?.code === "ECONNRESET") return true
  if (SessionV1.APIError.isInstance(error)) {
    if (((error.data as any).metadata as any)?.code === "ECONNRESET") return true
    if (((error.data as any).metadata as any)?.code === "StalledStreamError") return true
  }
  return (
    msg.includes("stream ended without finish") ||
    msg.includes("sse stalled") ||
    msg.includes("no content within timeout") ||
    msg.includes("econnreset") ||
    msg.includes("socket connection was closed") ||
    msg.includes("connection was closed unexpectedly") ||
    msg.includes("the connection was closed") ||
    msg.includes("timed out") ||
    msg.includes("timeout") ||
    msg.includes("service timeout") ||
    msg.includes("authentication service")
  )
}

export function policy(opts: {
  parse: (error: unknown) => Err
  set: (input: { attempt: number; message: string; next: number; isRateLimit: boolean }) => Effect.Effect<void>
  onRateLimited?: (info: { retryAfterMs?: number }) => void | Effect.Effect<void>
  onKeyExhausted?: (info: { exhausted?: boolean }) => void | Effect.Effect<void>
  onInvalidKey?: () => void | Effect.Effect<void>
  canRotateKey?: () => Effect.Effect<boolean>
  delay?: (input: { attempt: number; isRateLimit: boolean }) => Effect.Effect<Duration.Duration>
  shouldContinue?: (input: { attempt: number; isRateLimit: boolean }) => Effect.Effect<boolean>
}) {
  return Schedule.fromStepWithMetadata(
    Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
      const error = opts.parse(meta.input)
      const result = retryable(error)
      if (!result) {
        return Cause.done(meta.attempt)
      }
      return Effect.gen(function* () {
        const canRotate = opts.canRotateKey ? yield* opts.canRotateKey() : false
        const rotateTrigger = canRotate && isRotateTrigger(error)
        const treatAsRateLimit = result.isRateLimit || result.isExhaustion || result.isInvalid || rotateTrigger
        const maxRetries = treatAsRateLimit ? MAX_RETRIES_RATE_LIMIT : MAX_RETRIES
        if (meta.attempt > maxRetries) {
          const shouldContinue = opts.shouldContinue
            ? yield* opts.shouldContinue({ attempt: meta.attempt, isRateLimit: treatAsRateLimit })
            : false
          if (!shouldContinue) {
            return yield* Effect.fail(Cause.done(meta.attempt))
          }
        }
        const now = yield* Clock.currentTimeMillis
        if (treatAsRateLimit) {
          if (result.isInvalid) {
            const effect = opts.onInvalidKey?.()
            if (effect && Effect.isEffect(effect)) yield* effect
          } else if (result.isExhaustion) {
            const effect = opts.onKeyExhausted?.({ exhausted: true })
            if (effect && Effect.isEffect(effect)) yield* effect
          } else {
            const retryAfterMs = result.isRateLimit ? result.retryAfterMs : ROTATE_COOLDOWN_MS
            const effect = opts.onRateLimited?.({ retryAfterMs })
            if (effect && Effect.isEffect(effect)) yield* effect
          }
        }
        const baseWait = treatAsRateLimit ? 0 : RETRY_FIXED_DELAY
        const delay = opts.delay
          ? yield* opts.delay({ attempt: meta.attempt, isRateLimit: treatAsRateLimit })
          : Duration.millis(baseWait)
        const finalMs = treatAsRateLimit
          ? Math.max(Duration.toMillis(delay), ROTATE_DELAY_FLOOR_MS)
          : Duration.toMillis(delay)
        yield* opts.set({
          attempt: meta.attempt,
          message: result.message,
          next: now + finalMs,
          isRateLimit: treatAsRateLimit,
        })
        return [meta.attempt, Duration.millis(finalMs)] as [number, Duration.Duration]
      })
    }),
  )
}

export * as SessionRetry from "./retry"
