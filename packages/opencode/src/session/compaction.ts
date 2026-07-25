import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Session } from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"
import { Token } from "@/util/token"
import { SessionProcessor } from "./processor"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { NotFoundError } from "@/storage/storage"

import { Effect, Layer, Context, Option } from "effect"
import { Goal } from "./goal"
import { InstanceState } from "@/effect/instance-state"
import { isOverflow as overflow, usable } from "./overflow"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { buildPrompt } from "@opencode-ai/core/session/compaction"
import { SessionCompactionEvent } from "@opencode-ai/schema/session-compaction-event"

export const Event = SessionCompactionEvent

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
const TOOL_OUTPUT_MAX_CHARS = 5_000
const PRUNE_PROTECTED_TOOLS = ["skill"]
const DEFAULT_TAIL_TURNS = 2
const MIN_PRESERVE_RECENT_TOKENS = 2_000
const MAX_PRESERVE_RECENT_TOKENS = 10_000
// Import single source of truth from core (aligned with Claude Code thresholds)
import {
  AUTOCOMPACT_BUFFER_TOKENS as CORE_AUTOCOMPACT_BUFFER,
  WARNING_THRESHOLD_BUFFER_TOKENS as CORE_WARNING_BUFFER,
  MANUAL_COMPACT_BUFFER_TOKENS as CORE_MANUAL_BUFFER,
  MAX_CONSECUTIVE_COMPACTION_FAILURES as CORE_MAX_FAILURES,
  COMPACT_MAX_OUTPUT_TOKENS as CORE_COMPACT_MAX,
} from "@opencode-ai/core/session/compaction"

export const AUTOCOMPACT_BUFFER_TOKENS = CORE_AUTOCOMPACT_BUFFER
export const WARNING_THRESHOLD_BUFFER_TOKENS = CORE_WARNING_BUFFER
export const MANUAL_COMPACT_BUFFER_TOKENS = CORE_MANUAL_BUFFER
export const MAX_CONSECUTIVE_COMPACTION_FAILURES = CORE_MAX_FAILURES
const SUMMARY_MAX_OUTPUT_TOKENS = CORE_COMPACT_MAX

// Circuit breaker for V1 compaction failures (mirrors V2 and Claude's 3-failure breaker)
const FAILURE_TRACKER_V1_TTL_MS = 10 * 60 * 1000
const FAILURE_TRACKER_V1_MAX_SIZE = 1000
const failureTrackerV1 = new Map<string, { count: number; lastFailure: number }>()

const pruneFailureTrackerV1 = () => {
  if (failureTrackerV1.size <= FAILURE_TRACKER_V1_MAX_SIZE) return
  const now = Date.now()
  for (const [key, value] of failureTrackerV1) {
    if (now - value.lastFailure > FAILURE_TRACKER_V1_TTL_MS) failureTrackerV1.delete(key)
    if (failureTrackerV1.size <= FAILURE_TRACKER_V1_MAX_SIZE * 0.8) break
  }
  if (failureTrackerV1.size > FAILURE_TRACKER_V1_MAX_SIZE) {
    const entries = Array.from(failureTrackerV1.entries()).sort((a, b) => a[1].lastFailure - b[1].lastFailure)
    for (let i = 0; i < entries.length - FAILURE_TRACKER_V1_MAX_SIZE; i++) {
      failureTrackerV1.delete(entries[i]![0])
    }
  }
}

const getFailureCountV1 = (sessionID: string) => {
  const entry = failureTrackerV1.get(sessionID)
  if (!entry) return 0
  if (Date.now() - entry.lastFailure > FAILURE_TRACKER_V1_TTL_MS) {
    failureTrackerV1.delete(sessionID)
    return 0
  }
  return entry.count
}

const recordFailureV1 = (sessionID: string) => {
  pruneFailureTrackerV1()
  const existing = failureTrackerV1.get(sessionID)
  const now = Date.now()
  if (existing) {
    if (now - existing.lastFailure > FAILURE_TRACKER_V1_TTL_MS) {
      failureTrackerV1.set(sessionID, { count: 1, lastFailure: now })
    } else {
      failureTrackerV1.set(sessionID, { count: existing.count + 1, lastFailure: now })
    }
  } else {
    failureTrackerV1.set(sessionID, { count: 1, lastFailure: now })
  }
}
type Turn = {
  start: number
  end: number
  id: MessageID
}

type Tail = {
  start: number
  id: MessageID
}

type CompletedCompaction = {
  userIndex: number
  assistantIndex: number
  summary: string | undefined
}

function summaryText(message: SessionV1.WithParts) {
  const text = message.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return text || undefined
}

function completedCompactions(messages: SessionV1.WithParts[]) {
  const users = new Map<MessageID, number>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (!msg.parts.some((part) => part.type === "compaction")) continue
    users.set(msg.info.id, i)
  }

  return messages.flatMap((msg, assistantIndex): CompletedCompaction[] => {
    if (msg.info.role !== "assistant") return []
    if (!msg.info.summary || !msg.info.finish || msg.info.error) return []
    const userIndex = users.get(msg.info.parentID)
    if (userIndex === undefined) return []
    return [{ userIndex, assistantIndex, summary: summaryText(msg) }]
  })
}

function preserveRecentBudget(input: { cfg: ConfigV1.Info; model: Provider.Model }) {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(input) * 0.25)))
  )
}

function turns(messages: SessionV1.WithParts[]) {
  const result: Turn[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (msg.parts.some((part) => part.type === "compaction")) continue
    result.push({
      start: i,
      end: messages.length,
      id: msg.info.id,
    })
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start
  }
  return result
}

function splitTurn(input: {
  messages: SessionV1.WithParts[]
  turn: Turn
  model: Provider.Model
  budget: number
  estimate: (input: { messages: SessionV1.WithParts[]; model: Provider.Model }) => Effect.Effect<number>
}) {
  return Effect.gen(function* () {
    if (input.budget <= 0) return undefined
    if (input.turn.end - input.turn.start <= 1) return undefined
    // Start at turn.start+1 to allow splitting within a turn's assistant messages
    // The user message at turn.start is preserved in head (summarized) when we split to keep only suffix assistant
    for (let start = input.turn.start + 1; start < input.turn.end; start++) {
      let adjustedStart = start
      // Preserve tool_use/result pairing: if suffix starts with text-only assistant that follows a tool-containing assistant,
      // include the tool assistant to avoid orphaned dependency (mirrors Claude's adjustIndexToPreserveAPIInvariants)
      const candidateFirst = input.messages[adjustedStart]
      if (candidateFirst && candidateFirst.info.role === "assistant") {
        const prev = input.messages[adjustedStart - 1]
        if (
          prev &&
          prev.info.role === "assistant" &&
          prev.parts.some((p) => p.type === "tool") &&
          !candidateFirst.parts.some((p) => p.type === "tool")
        ) {
          // Walk back to include all consecutive tool-containing assistants
          let walk = adjustedStart - 1
          while (
            walk > input.turn.start &&
            input.messages[walk - 1]?.info.role === "assistant" &&
            input.messages[walk - 1]?.parts.some((p) => p.type === "tool")
          ) {
            walk--
          }
          adjustedStart = walk
        }
      }

      const size = yield* input.estimate({
        messages: input.messages.slice(adjustedStart, input.turn.end),
        model: input.model,
      })
      if (size > input.budget) continue
      return {
        start: adjustedStart,
        id: input.messages[adjustedStart]!.info.id,
      } satisfies Tail
    }
    return undefined
  })
}

function truncateHeadForPTLRetryV1(messages: SessionV1.WithParts[], requiredReduction: number, estimator: (msgs: SessionV1.WithParts[]) => number) {
  // Group by turns, drop oldest turns until reduction met or 20% dropped (like Claude's PTL retry)
  if (messages.length <= 1) return null
  const turnStarts: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.info.role === "user" && !messages[i]!.parts.some((p) => p.type === "compaction")) {
      turnStarts.push(i)
    }
  }
  if (turnStarts.length <= 1) {
    // Fallback when no turns detected: drop oldest 20% but preserve tool invariants
    // Ensure we don't cut inside an assistant tool sequence - walk to next assistant boundary without tool
    let dropCount = Math.max(1, Math.floor(messages.length * 0.2))
    // Adjust dropCount to not split inside tool-containing assistant chain
    while (
      dropCount < messages.length &&
      messages[dropCount]!.info.role === "assistant" &&
      messages[dropCount - 1]?.info.role === "assistant" &&
      messages[dropCount - 1]?.parts.some((p) => p.type === "tool")
    ) {
      dropCount++
    }
    return messages.slice(dropCount)
  }
  let droppedTokens = 0
  let dropTurns = 0
  for (let t = 0; t < turnStarts.length - 1; t++) {
    const start = turnStarts[t]!
    const end = turnStarts[t + 1]!
    const slice = messages.slice(start, end)
    droppedTokens += estimator(slice)
    dropTurns = t + 1
    if (droppedTokens >= requiredReduction) break
  }
  if (dropTurns === 0) dropTurns = Math.max(1, Math.floor(turnStarts.length * 0.2))
  const cutoff = turnStarts[dropTurns]
  if (cutoff === undefined || cutoff >= messages.length) return null
  return messages.slice(cutoff)
}

export interface Interface {
  readonly isOverflow: (input: {
    tokens: SessionV1.Assistant["tokens"]
    model: Provider.Model
  }) => Effect.Effect<boolean>
  readonly prune: (input: { sessionID: SessionID }) => Effect.Effect<void>
  readonly process: (input: {
    parentID: MessageID
    messages: SessionV1.WithParts[]
    sessionID: SessionID
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<"continue" | "stop">
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const plugin = yield* Plugin.Service
    const processors = yield* SessionProcessor.Service
    const provider = yield* Provider.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    const goals = yield* Goal.Service

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: SessionV1.Assistant["tokens"]
      model: Provider.Model
    }) {
      return overflow({
        cfg: yield* config.get(),
        tokens: input.tokens,
        model: input.model,
        outputTokenMax: flags.outputTokenMax,
      })
    })

    const estimate = Effect.fn("SessionCompaction.estimate")(function* (input: {
      messages: SessionV1.WithParts[]
      model: Provider.Model
    }) {
      const msgs = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
      return Token.estimate(JSON.stringify(msgs))
    })

    const select = Effect.fn("SessionCompaction.select")(function* (input: {
      messages: SessionV1.WithParts[]
      cfg: ConfigV1.Info
      model: Provider.Model
    }) {
      const limit = input.cfg.compaction?.tail_turns ?? DEFAULT_TAIL_TURNS
      if (limit <= 0) return { head: input.messages, tail_start_id: undefined }
      const budget = preserveRecentBudget({ cfg: input.cfg, model: input.model })
      const all = turns(input.messages)
      if (!all.length) return { head: input.messages, tail_start_id: undefined }
      const recent = all.slice(-limit)
      const sizes = yield* Effect.forEach(
        recent,
        (turn) =>
          estimate({
            messages: input.messages.slice(turn.start, turn.end),
            model: input.model,
          }),
        { concurrency: 1 },
      )

      let total = 0
      let keep: Tail | undefined
      for (let i = recent.length - 1; i >= 0; i--) {
        const turn = recent[i]!
        const size = sizes[i]
        if (total + size <= budget) {
          total += size
          keep = { start: turn.start, id: turn.id }
          continue
        }
        const remaining = budget - total
        const split = yield* splitTurn({
          messages: input.messages,
          turn,
          model: input.model,
          budget: remaining,
          estimate,
        })
        if (split) keep = split
        else if (!keep) {
          yield* Effect.logInfo("tail fallback", { budget, size, total })
        }
        break
      }

      if (!keep || keep.start === 0) return { head: input.messages, tail_start_id: undefined }
      return {
        head: input.messages.slice(0, keep.start),
        tail_start_id: keep.id,
      }
    })

    // goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool
    // calls, then erases output of older tool calls to free context space
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
      const cfg = yield* config.get()
      if (!cfg.compaction?.prune) return
      yield* Effect.logInfo("pruning")

      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return

      let total = 0
      let pruned = 0
      const toPrune: SessionV1.ToolPart[] = []
      let turns = 0

      loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]
        if (msg.info.role === "user") turns++
        if (turns < 2) continue
        if (msg.info.role === "assistant" && msg.info.summary) break loop
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]
          if (part.type !== "tool") continue
          if (part.state.status !== "completed") continue
          if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
          if (part.state.time.compacted) break loop
          const estimate = Token.estimate(part.state.output)
          total += estimate
          if (total <= PRUNE_PROTECT) continue
          pruned += estimate
          toPrune.push(part)
        }
      }

      yield* Effect.logInfo("found", { pruned, total })
      if (pruned > PRUNE_MINIMUM) {
        for (const part of toPrune) {
          if (part.state.status === "completed") {
            part.state.time.compacted = Date.now()
            yield* session.updatePart(part)
          }
        }
        yield* Effect.logInfo("pruned", { count: toPrune.length })
      }
    })

    const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
      parentID: MessageID
      messages: SessionV1.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
    }) {
      // Circuit breaker: avoid repeated failures (Claude's 250k wasted calls/day protection)
      const failureCount = getFailureCountV1(input.sessionID)
      if (failureCount >= MAX_CONSECUTIVE_COMPACTION_FAILURES) {
        yield* Effect.logWarning("V1 Compaction circuit breaker triggered", {
          sessionID: input.sessionID,
          failures: failureCount,
        })
        return "stop" as const
      }

      const parent = input.messages.findLast((m) => m.info.id === input.parentID)
      if (!parent || parent.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      const userMessage = parent.info
      const compactionPart = parent.parts.find((part): part is SessionV1.CompactionPart => part.type === "compaction")

      let messages = input.messages
      let replay:
        | {
            info: SessionV1.User
            parts: SessionV1.Part[]
          }
        | undefined
      if (input.overflow) {
        const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
        for (let i = idx - 1; i >= 0; i--) {
          const msg = input.messages[i]
          if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
            replay = { info: msg.info, parts: msg.parts }
            messages = input.messages.slice(0, i)
            break
          }
        }
        const hasContent =
          replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
        if (!hasContent) {
          replay = undefined
          messages = input.messages
        }
      }

      const agent = yield* agents.get("compaction")
      const model = agent.model
        ? yield* provider.getModel(agent.model.providerID, agent.model.modelID).pipe(Effect.orDie)
        : yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID).pipe(Effect.orDie)
      const cfg = yield* config.get()
      const history = compactionPart && messages.at(-1)?.info.id === input.parentID ? messages.slice(0, -1) : messages
      const prior = completedCompactions(history)
      const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
      const previousSummary = prior.at(-1)?.summary
      const selected = yield* select({
        messages: history.filter((_, index) => !hidden.has(index)),
        cfg,
        model,
      })
      // Allow plugins to inject context or replace compaction prompt.
      const compacting = yield* plugin.trigger(
        "experimental.session.compacting",
        { sessionID: input.sessionID },
        { context: [], prompt: undefined },
      )
      const goalResult = yield* goals.get(input.sessionID).pipe(Effect.option)
      const goal = Option.isSome(goalResult) ? goalResult.value : undefined
      const goalContext = goal
        ? [`Active session goal (preserve in summary): ${goal.text.slice(0, 1000)}${goal.text.length > 1000 ? "…" : ""}`]
        : []
      const nextPromptBase =
        compacting.prompt ?? buildPrompt({ previousSummary, context: [...compacting.context, ...goalContext] })

      // PTL retry: if head too large for context, truncate oldest turns (Claude's truncateHeadForPTLRetry)
      let headForPrompt = selected.head
      let currentPrompt = nextPromptBase

      const transformForEstimation = (source: SessionV1.WithParts[]) =>
        Effect.gen(function* () {
          const cloned = structuredClone(source)
          yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: cloned })
          return yield* MessageV2.toModelMessagesEffect(cloned, model, {
            stripMedia: true,
            toolOutputMaxChars: TOOL_OUTPUT_MAX_CHARS,
          })
        })

      let modelMessages = yield* transformForEstimation(headForPrompt)

      const estimatePrompt = (p: typeof modelMessages) =>
        Token.estimate(JSON.stringify([...p, { role: "user", content: [{ type: "text", text: currentPrompt }] }]))

      let ptlRetries = 0
      while (estimatePrompt(modelMessages) > model.limit.context - SUMMARY_MAX_OUTPUT_TOKENS && ptlRetries < 3) {
        const required = estimatePrompt(modelMessages) - (model.limit.context - SUMMARY_MAX_OUTPUT_TOKENS)
        const truncated = truncateHeadForPTLRetryV1(headForPrompt, required, (slice) =>
          Token.estimate(JSON.stringify(slice)),
        )
        if (!truncated) break
        headForPrompt = truncated
        modelMessages = yield* transformForEstimation(headForPrompt)
        ptlRetries++
        yield* Effect.logInfo("V1 Compaction PTL retry", { retry: ptlRetries, required, newLength: headForPrompt.length })
      }

      const nextPrompt = currentPrompt
      const ctx = yield* InstanceState.context
      const msg: SessionV1.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: input.parentID,
        sessionID: input.sessionID,
        mode: "compaction",
        agent: "compaction",
        variant: userMessage.model.variant,
        summary: true,
        path: {
          cwd: ctx.directory,
          root: ctx.worktree,
        },
        cost: 0,
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: model.id,
        providerID: model.providerID,
        time: {
          created: Date.now(),
        },
      }
      yield* session.updateMessage(msg)
      const processor = yield* processors.create({
        assistantMessage: msg,
        sessionID: input.sessionID,
        model,
      })
      const result = yield* processor.process({
        user: userMessage,
        agent,
        sessionID: input.sessionID,
        tools: {},
        system: [],
        messages: [
          ...modelMessages,
          {
            role: "user",
            content: [{ type: "text", text: nextPrompt }],
          },
        ],
        model,
      })

      if (result === "compact") {
        processor.message.error = new SessionV1.ContextOverflowError({
          message: replay
            ? "Conversation history too large to compact - exceeds model context limit"
            : "Session too large to compact - context exceeds model limit even after stripping media",
        }).toObject()
        processor.message.finish = "error"
        yield* session.updateMessage(processor.message)
        recordFailureV1(input.sessionID)
        return "stop"
      }

      if (compactionPart && compactionPart.tail_start_id !== selected.tail_start_id) {
        yield* session.updatePart({
          ...compactionPart,
          tail_start_id: selected.tail_start_id,
        })
      }

      if (result === "continue" && input.auto) {
        if (replay) {
          const original = replay.info
          const replayMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: input.sessionID,
            time: { created: Date.now() },
            agent: original.agent,
            model: original.model,
            format: original.format,
            tools: original.tools,
            system: original.system,
          })
          for (const part of replay.parts) {
            if (part.type === "compaction") continue
            const replayPart =
              part.type === "file" && MessageV2.isMedia(part.mime)
                ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
                : part
            yield* session.updatePart({
              ...replayPart,
              id: PartID.ascending(),
              messageID: replayMsg.id,
              sessionID: input.sessionID,
            })
          }
        }

        if (!replay) {
          const info = yield* provider.getProvider(userMessage.model.providerID)
          if (
            (yield* plugin.trigger(
              "experimental.compaction.autocontinue",
              {
                sessionID: input.sessionID,
                agent: userMessage.agent,
                model: yield* provider
                  .getModel(userMessage.model.providerID, userMessage.model.modelID)
                  .pipe(Effect.orDie),
                provider: {
                  source: info.source,
                  info,
                  options: info.options,
                },
                message: userMessage,
                overflow: input.overflow === true,
              },
              { enabled: true },
            )).enabled
          ) {
            const continueMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: userMessage.agent,
              model: userMessage.model,
            })
            const text =
              (input.overflow
                ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
                : "") +
              "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: continueMsg.id,
              sessionID: input.sessionID,
              type: "text",
              // Internal marker for auto-compaction followups so provider plugins
              // can distinguish them from manual post-compaction user prompts.
              // This is not a stable plugin contract and may change or disappear.
              metadata: { compaction_continue: true },
              synthetic: true,
              text,
              time: {
                start: Date.now(),
                end: Date.now(),
              },
            })
          }
        }
      }

      if (processor.message.error) {
        recordFailureV1(input.sessionID)
        return "stop"
      }
      if (result === "continue") {
        failureTrackerV1.delete(input.sessionID)
        yield* events.publish(Event.Compacted, { sessionID: input.sessionID })
      }
      return result
    })

    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      auto: boolean
      overflow?: boolean
    }) {
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
      })
    })

    return Service.of({
      isOverflow,
      prune,
      process: processCompaction,
      create,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Config.node,
    Session.node,
    Agent.node,
    Plugin.node,
    SessionProcessor.node,
    Provider.node,
    EventV2Bridge.node,
    RuntimeFlags.node,
    Goal.node,
  ],
})

export * as SessionCompaction from "./compaction"
