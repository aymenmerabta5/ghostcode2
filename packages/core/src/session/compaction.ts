export * as SessionCompaction from "./compaction"

import { LLM, LLMError, LLMEvent, Message, type LLMRequest, type Model } from "@opencode-ai/llm"
import { DateTime, Effect, Stream } from "effect"
import type { Config } from "../config"
import type { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { Token } from "../util/token"

const DEFAULT_BUFFER = 13_000
const DEFAULT_KEEP_TOKENS = 8_000
const TOOL_OUTPUT_MAX_CHARS = 5_000
const SUMMARY_OUTPUT_TOKENS = 20_000

// Aligned with Claude Code thresholds (services/compact/autoCompact.ts)
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000
export const MAX_CONSECUTIVE_COMPACTION_FAILURES = 3
export const COMPACT_MAX_OUTPUT_TOKENS = 20_000

// Post-compact restoration budgets (mirrors Claude: 5 files * 5k, 25k skills)
export const POST_COMPACT_MAX_FILES_TO_RESTORE = 5
export const POST_COMPACT_TOKEN_BUDGET = 50_000
export const POST_COMPACT_MAX_TOKENS_PER_FILE = 5_000
export const POST_COMPACT_MAX_TOKENS_PER_SKILL = 5_000
export const POST_COMPACT_SKILLS_TOKEN_BUDGET = 25_000

const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`

const DETAILED_ANALYSIS = `Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like file names, full code snippets, function signatures, file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness.

`

const SUMMARY_TEMPLATE = `${NO_TOOLS_PREAMBLE}${DETAILED_ANALYSIS}Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail. This is the anchor for continuation.
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important. Preserve exact file paths and identifiers when known — do not abbreviate. For recent files, include the full relevant snippet (up to 5k tokens logic) to aid continuation.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent. Include direct quotes where helpful, especially for recent messages.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable. This section is most critical for resuming correctly.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. Include direct quotes from the most recent conversation showing what the next action should be. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests or really old requests that were already completed without confirming with the user first.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]

3. Files and Code Sections:
   - [File Name 1]
     - [Summary of why this file is important]
     - [Summary of the changes made to this file, if any]
     - [Important Code Snippet]

4. Errors and fixes:
   - [Detailed description of error 1]:
     - [How you fixed the error]
     - [User feedback on the error if any]

5. Problem Solving:
   [Description of solved problems and ongoing troubleshooting]

6. All user messages:
   - [Detailed non tool use user message]

7. Pending Tasks:
   - [Task 1]
   - [Task 2]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]

</summary>
</example>

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.

There may be additional summarization instructions provided in the included context. If so, remember to follow these instructions when creating the above summary.

REMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.`

type Entry = {
  readonly seq: number
  readonly message: SessionMessage.Message
}

type Settings = {
  readonly auto: boolean
  readonly buffer: number
  readonly tokens: number
}

type Dependencies = {
  readonly events: EventV2.Interface
  readonly llm: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
  }
  readonly config: readonly Config.Entry[]
}

type Input = {
  readonly sessionID: SessionSchema.ID
  readonly entries: readonly Entry[]
  readonly model: Model
  readonly request: LLMRequest
}

const estimate = (value: unknown) => Token.estimate(JSON.stringify(value))

const truncate = (value: string) => {
  if (value.length <= TOOL_OUTPUT_MAX_CHARS) return value
  // Preserve head (80%) and tail (20%) to keep context at both ends, like Claude's per-file budget
  const headSize = Math.ceil(TOOL_OUTPUT_MAX_CHARS * 0.8)
  const tailSize = TOOL_OUTPUT_MAX_CHARS - headSize
  const truncatedChars = value.length - TOOL_OUTPUT_MAX_CHARS
  return `${value.slice(0, headSize)}\n[...truncated ${truncatedChars} chars, total ${value.length} chars; head ${headSize} + tail ${tailSize} preserved...]\n${tailSize > 0 ? value.slice(-tailSize) : ""}`
}

export const calculateTokenWarningState = (tokenCount: number, contextWindow: number, outputReserve?: number) => {
  const effectiveWindow = contextWindow - Math.min(outputReserve ?? SUMMARY_OUTPUT_TOKENS, COMPACT_MAX_OUTPUT_TOKENS)
  const autoThreshold = effectiveWindow - AUTOCOMPACT_BUFFER_TOKENS
  const warningThreshold = autoThreshold - WARNING_THRESHOLD_BUFFER_TOKENS
  const blockingLimit = effectiveWindow - MANUAL_COMPACT_BUFFER_TOKENS

  // Guard against tiny contexts where thresholds become non-positive (division by zero / negative percent)
  if (autoThreshold <= 0) {
    return {
      effectiveWindow,
      autoThreshold,
      warningThreshold,
      blockingLimit,
      isAboveWarning: true,
      shouldAutoCompact: true,
      isAtBlockingLimit: tokenCount >= blockingLimit,
      percentRemaining: 0,
      percentUsed: 100,
    }
  }

  const remainingToAuto = autoThreshold - tokenCount
  const percentRemaining = Math.max(0, Math.min(100, (remainingToAuto / autoThreshold) * 100))
  return {
    effectiveWindow,
    autoThreshold,
    warningThreshold,
    blockingLimit,
    isAboveWarning: tokenCount >= warningThreshold,
    shouldAutoCompact: tokenCount >= autoThreshold,
    isAtBlockingLimit: tokenCount >= blockingLimit,
    percentRemaining,
    percentUsed: 100 - percentRemaining,
  }
}

export const serializeToolContent = (content: SessionMessage.ToolStateCompleted["content"]) =>
  content
    .map((item) =>
      item.type === "text" ? item.text : `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`,
    )
    .join("\n")

const serialize = (message: SessionMessage.Message) => {
  if (message.type === "user") {
    const files = message.files?.map((file) => `[Attached ${file.mime}: ${file.name ?? file.uri}]`) ?? []
    return [`[User]: ${message.text}`, ...files].join("\n")
  }
  if (message.type === "assistant") {
    return message.content
      .flatMap((part) => {
        if (part.type === "text") return [`[Assistant]: ${part.text}`]
        if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
        const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
        if (part.state.status === "completed")
          return [
            `[Assistant tool call]: ${part.name}(${input})`,
            `[Tool result]: ${truncate(serializeToolContent(part.state.content))}`,
          ]
        if (part.state.status === "error")
          return [`[Assistant tool call]: ${part.name}(${input})`, `[Tool error]: ${part.state.error.message}`]
        return [`[Assistant tool call]: ${part.name}(${input})`]
      })
      .join("\n")
  }
  if (message.type === "system") return `[System update]: ${message.text}`
  if (message.type === "synthetic") return `[Synthetic context]: ${message.text}`
  if (message.type === "shell") return `[Shell]: ${message.command}\n${truncate(message.output)}`
  return ""
}

const settings = (documents: readonly Config.Entry[]) => {
  const configured = documents
    .filter((entry): entry is Config.Document => entry.type === "document")
    .flatMap((entry) => (entry.info.compaction ? [entry.info.compaction] : []))
  return configured.reduce<Settings>(
    (result, current) => ({
      auto: current.auto ?? result.auto,
      buffer: current.buffer ?? result.buffer,
      tokens: current.keep?.tokens ?? result.tokens,
    }),
    { auto: true, buffer: DEFAULT_BUFFER, tokens: DEFAULT_KEEP_TOKENS },
  )
}

type SerializedEntry = {
  readonly seq: number
  readonly serialized: string
  readonly tokenEstimate: number
}

type TurnGroup = {
  readonly startSeq: number
  readonly entries: readonly SerializedEntry[]
  readonly combined: string
  readonly tokenEstimate: number
}

const groupIntoTurns = (serializedEntries: readonly SerializedEntry[]): readonly TurnGroup[] => {
  if (serializedEntries.length === 0) return []
  const groups: TurnGroup[] = []
  let currentEntries: SerializedEntry[] = []
  let currentStartSeq = serializedEntries[0]!.seq

  for (const item of serializedEntries) {
    // A user message starts a new turn (unless it's the very first entry of current group being user)
    const isUserStart = item.serialized.startsWith("[User]:")
    if (isUserStart && currentEntries.length > 0) {
      const combined = currentEntries.map((e) => e.serialized).join("\n\n")
      groups.push({
        startSeq: currentStartSeq,
        entries: currentEntries,
        combined,
        tokenEstimate: Token.estimate(combined),
      })
      currentEntries = [item]
      currentStartSeq = item.seq
    } else {
      currentEntries.push(item)
    }
  }
  if (currentEntries.length > 0) {
    const combined = currentEntries.map((e) => e.serialized).join("\n\n")
    groups.push({
      startSeq: currentStartSeq,
      entries: currentEntries,
      combined,
      tokenEstimate: Token.estimate(combined),
    })
  }
  return groups
}

const select = (
  entries: readonly Entry[],
  tokens: number,
): { readonly head: string; readonly recent: string } | undefined => {
  const serializedEntries: SerializedEntry[] = entries
    .filter((entry) => entry.message.type !== "compaction")
    .map((entry) => {
      const s = serialize(entry.message)
      if (!s) return undefined
      return { seq: entry.seq, serialized: s, tokenEstimate: Token.estimate(s) }
    })
    .filter((v): v is SerializedEntry => v !== undefined)

  if (serializedEntries.length === 0) return

  // Group into turns to preserve tool_use/result pairs together (mirrors Claude's groupMessagesByApiRound)
  const turns = groupIntoTurns(serializedEntries)

  let total = 0
  let splitTurnIndex = turns.length
  let splitPrefix = ""
  let splitSuffix = ""

  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!
    const next = total + turn.tokenEstimate
    if (next > tokens) {
      // This turn doesn't fully fit. Try to keep its suffix within remaining budget.
      const remainingTokens = Math.max(0, tokens - total)
      const remainingChars = remainingTokens * 4

      if (remainingChars > 500 && turn.entries.length > 1) {
        // Try to keep tail entries of this turn that fit
        let tailTokens = 0
        let tailStart = turn.entries.length
        for (let j = turn.entries.length - 1; j >= 0; j--) {
          const e = turn.entries[j]!
          if (tailTokens + e.tokenEstimate > remainingTokens) {
            if (tailStart !== turn.entries.length) break
            // Allow at least one entry even if it exceeds budget (better to overrun slightly than drop all)
            // Continue to include it and break after
            if (tailTokens === 0) {
              tailStart = j
              break
            }
            break
          }
          tailTokens += e.tokenEstimate
          tailStart = j
        }
        if (tailStart < turn.entries.length) {
          const headPart = tailStart > 0 ? turn.entries.slice(0, tailStart).map((e) => e.serialized).join("\n\n") : ""
          const tailPart = turn.entries.slice(tailStart).map((e) => e.serialized).join("\n\n")
          splitPrefix = headPart
          splitSuffix = tailPart
          splitTurnIndex = i // head ends before this turn, recent starts with splitSuffix + later turns
          // Adjust invariants: if tail starts with tool result, include preceding tool call from same turn
          if (
            tailPart.trim().startsWith("[Tool result]") ||
            tailPart.trim().startsWith("[Tool error]") ||
            tailPart.trimStart().startsWith("[Tool result]:")
          ) {
            const lastHeadEntry = tailStart > 0 ? turn.entries[tailStart - 1] : undefined
            if (lastHeadEntry && lastHeadEntry.serialized.includes("[Assistant tool call]")) {
              splitPrefix = tailStart > 1 ? turn.entries.slice(0, tailStart - 1).map((e) => e.serialized).join("\n\n") : ""
              splitSuffix = turn.entries.slice(tailStart - 1).map((e) => e.serialized).join("\n\n")
            }
          }
          break
        }
      }

      if (remainingChars > 0 && remainingChars < turn.combined.length) {
        // Final fallback: char-level split but align to line boundary
        // Prefer splitting at \n\n boundary near cutoff to avoid breaking mid-message
        const cutoff = turn.combined.length - remainingChars
        let splitPos = turn.combined.lastIndexOf("\n\n", cutoff)
        if (splitPos === -1 || splitPos < cutoff - 500) {
          // If no boundary near cutoff, try forward search from cutoff
          const forward = turn.combined.indexOf("\n\n", cutoff)
          if (forward !== -1 && forward <= cutoff + 500) splitPos = forward
          else splitPos = cutoff
        }
        // Ensure we don't split inside a tool call/result pair - look ahead for tool result marker at start of suffix
        let suffixCandidate = turn.combined.slice(splitPos).trimStart()
        let prefixCandidate = turn.combined.slice(0, splitPos)

        // If suffix starts with tool result, walk prefix back to find preceding tool call and include it
        if (suffixCandidate.startsWith("[Tool result]") || suffixCandidate.startsWith("[Tool error]")) {
          const lastToolCallIdx = prefixCandidate.lastIndexOf("[Assistant tool call]")
          if (lastToolCallIdx > prefixCandidate.length - 2000) {
            // Include that tool call in suffix to preserve pair
            suffixCandidate = prefixCandidate.slice(lastToolCallIdx) + "\n\n" + suffixCandidate
            prefixCandidate = prefixCandidate.slice(0, lastToolCallIdx)
          }
        }

        splitPrefix = prefixCandidate
        splitSuffix = suffixCandidate
        splitTurnIndex = i
      }
      break
    }
    total = next
    splitTurnIndex = i
  }

  // When split occurs inside a turn, splitPrefix/splitSuffix contain that turn's split parts.
  // In that case, head should be turns before i + splitPrefix, recent should be splitSuffix + turns after i.
  // When split is at turn boundary (no internal split), splitPrefix/splitSuffix are empty and recent starts at i.
  const hasInternalSplit = splitPrefix.length > 0 || splitSuffix.length > 0
  const headTurns = turns.slice(0, splitTurnIndex)
  const recentTurns = hasInternalSplit ? turns.slice(splitTurnIndex + 1) : turns.slice(splitTurnIndex)

  const head = [...headTurns.map((t) => t.combined), splitPrefix].filter(Boolean).join("\n\n")
  const recent = [splitSuffix, ...recentTurns.map((t) => t.combined)].filter(Boolean).join("\n\n")

  // Final invariant check: recent must not start with orphaned tool result
  const trimmedRecent = recent.trim()
  if (trimmedRecent.startsWith("[Tool result]") || trimmedRecent.startsWith("[Tool error]")) {
    if (headTurns.length > 0) {
      const lastHead = headTurns[headTurns.length - 1]!
      if (lastHead.combined.includes("[Assistant tool call]")) {
        // Move last head turn to recent to preserve pairing
        const newHeadTurns = headTurns.slice(0, -1)
        const newRecentTurns = [lastHead, ...recentTurns]
        return {
          head: [...newHeadTurns.map((t) => t.combined), splitPrefix].filter(Boolean).join("\n\n"),
          recent: [splitSuffix, ...newRecentTurns.map((t) => t.combined)].filter(Boolean).join("\n\n"),
        }
      }
    }
  }

  return { head, recent }
}

const SAFE_PATH_PATTERN = /^[a-zA-Z0-9_\-./\\ ]{1,500}$/
const MAX_PATH_LENGTH = 500

const isSafePath = (p: string): boolean => {
  if (!p || p.length === 0 || p.length > MAX_PATH_LENGTH) return false
  if (p.includes("..")) return false
  if (p.includes("<") || p.includes(">") || p.includes("\n") || p.includes("\r")) return false
  if (p.includes("</") || p.includes("<summary") || p.includes("<recent")) return false
  // Allow extensionless files (Dockerfile, Makefile) but require at least 1 char and not just dots
  if (!SAFE_PATH_PATTERN.test(p)) return false
  // Reject if contains null byte or control chars
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(p)) return false
  return true
}

export const extractRecentFilePaths = (recent: string): string[] => {
  const paths = new Set<string>()
  // More robust pattern: match Read tool calls with JSON payload that may contain parentheses inside strings.
  // We match up to the closing ')]' pattern by using balanced approach via locating JSON-like structures.
  // First try structured JSON extraction via matchAll of tool call blocks
  const toolCallRegex = /\[Assistant tool call\]:\s*Read\s*\((\{[\s\S]*?\})\)/gi
  for (const match of recent.matchAll(toolCallRegex)) {
    const raw = match[1]
    if (!raw) continue
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const candidate = (parsed.file ?? parsed.path ?? parsed.filePath) as unknown
      if (typeof candidate === "string" && isSafePath(candidate)) {
        paths.add(candidate)
      }
    } catch {
      // Ignore JSON parse errors - try fallback for plain paths
    }
    if (paths.size >= POST_COMPACT_MAX_FILES_TO_RESTORE) break
  }

  // Fallback: also match lowercase read and other variants with safer extraction
  if (paths.size < POST_COMPACT_MAX_FILES_TO_RESTORE) {
    const fallbackRegex = /\[Assistant tool call\]:\s*(?:Read|read)\s*\([^)]*"(?:file|path|filePath)"\s*:\s*"([^"]{1,500})"/gi
    for (const match of recent.matchAll(fallbackRegex)) {
      const candidate = match[1]
      if (candidate && isSafePath(candidate)) {
        paths.add(candidate)
      }
      if (paths.size >= POST_COMPACT_MAX_FILES_TO_RESTORE) break
    }
  }

  return Array.from(paths).slice(0, POST_COMPACT_MAX_FILES_TO_RESTORE)
}

export const extractRecentSkillNames = (recent: string): string[] => {
  const skills = new Set<string>()
  // Match skill invocations: [Assistant tool call]: SkillName or skill tool
  const skillRegex = /\[Assistant tool call\]:\s*(?:Skill|skill|UseSkill).*?\((?:\{[^}]*"name"\s*:\s*"([^"]+)"|[^)]*?([a-zA-Z0-9_-]+))\)/gi
  for (const match of recent.matchAll(skillRegex)) {
    const candidate = (match[1] ?? match[2] ?? "").trim()
    if (candidate && candidate.length > 0 && candidate.length < 100 && /^[a-zA-Z0-9_-]+$/.test(candidate)) {
      skills.add(candidate)
      if (skills.size >= 5) break
    }
  }
  // Also look for explicit skill mentions in recent context
  const mentionRegex = /(?:skill|Skill)\s*[:=]\s*([a-zA-Z0-9_-]{2,50})/g
  for (const match of recent.matchAll(mentionRegex)) {
    const candidate = match[1]
    if (candidate && /^[a-zA-Z0-9_-]+$/.test(candidate)) {
      skills.add(candidate)
      if (skills.size >= 5) break
    }
  }
  return Array.from(skills).slice(0, 5)
}

export const truncateHeadForPTLRetry = (head: string, requiredReduction: number): string | null => {
  // Split head into turn-like groups by double newline + user marker
  const groups = head.split(/\n\n(?=\[User\]:)/g)
  if (groups.length <= 1) {
    // Fallback split by \n\n
    const fallback = head.split("\n\n")
    if (fallback.length <= 1) return null
    const dropCount = Math.max(1, Math.floor(fallback.length * 0.2))
    const remaining = fallback.slice(dropCount)
    if (remaining.length === 0) return null
    return remaining.join("\n\n")
  }
  // Estimate tokens to drop: keep dropping oldest until we cover required reduction or 20%
  let droppedTokens = 0
  let dropIndex = 0
  for (let i = 0; i < groups.length; i++) {
    droppedTokens += Token.estimate(groups[i] ?? "")
    dropIndex = i + 1
    if (droppedTokens >= requiredReduction) break
  }
  if (dropIndex === 0) dropIndex = Math.max(1, Math.floor(groups.length * 0.2))
  const remaining = groups.slice(dropIndex)
  if (remaining.length === 0) return null
  return `[Earlier conversation truncated for compaction retry - ${dropIndex} turn(s) removed]\n\n${remaining.join("\n\n")}`
}

export function formatCompactSummary(summary: string): string {
  let formatted = summary
  formatted = formatted.replace(/<analysis>[\s\S]*?<\/analysis>/gi, "")
  const match = formatted.match(/<summary>([\s\S]*?)<\/summary>/i)
  if (match) {
    formatted = match[1] || ""
  }
  formatted = formatted.replace(/\n{3,}/g, "\n\n")
  return formatted.trim()
}

const escapePreviousSummaryXml = (str: string) =>
  str
    .replace(/<\/previous-summary\s*>/gi, "<\\/previous-summary>")
    .replace(/<\s*previous-summary\s*>/gi, "<\\previous-summary>")
    .replace(/<\/summary\s*>/gi, "<\\/summary>")

export const buildPrompt = (input: { readonly previousSummary?: string; readonly context: readonly string[] }) =>
  [
    input.previousSummary
      ? `Update the anchored summary below using the conversation history above.\nPreserve still-true details, remove stale details, and merge in the new facts.\n<previous-summary>\n${escapePreviousSummaryXml(input.previousSummary)}\n</previous-summary>`
      : "Create a new anchored summary from the conversation history.",
    SUMMARY_TEMPLATE,
    ...input.context,
  ].join("\n\n")

const FAILURE_TRACKER_TTL_MS = 10 * 60 * 1000 // 10 minutes
const FAILURE_TRACKER_MAX_SIZE = 1000

const failureTracker = new Map<string, { count: number; lastFailure: number }>()

const pruneFailureTracker = () => {
  if (failureTracker.size <= FAILURE_TRACKER_MAX_SIZE) return
  // Evict oldest entries first
  const now = Date.now()
  for (const [key, value] of failureTracker) {
    if (now - value.lastFailure > FAILURE_TRACKER_TTL_MS) failureTracker.delete(key)
    if (failureTracker.size <= FAILURE_TRACKER_MAX_SIZE * 0.8) break
  }
  // If still over limit, evict oldest regardless of TTL
  if (failureTracker.size > FAILURE_TRACKER_MAX_SIZE) {
    const entries = Array.from(failureTracker.entries()).sort((a, b) => a[1].lastFailure - b[1].lastFailure)
    for (let i = 0; i < entries.length - FAILURE_TRACKER_MAX_SIZE; i++) {
      failureTracker.delete(entries[i]![0])
    }
  }
}

const recordCompactionFailure = (sessionID: string) => {
  pruneFailureTracker()
  const existing = failureTracker.get(sessionID)
  const now = Date.now()
  if (existing) {
    // Decay if last failure was outside TTL: reset count
    if (now - existing.lastFailure > FAILURE_TRACKER_TTL_MS) {
      failureTracker.set(sessionID, { count: 1, lastFailure: now })
    } else {
      failureTracker.set(sessionID, { count: existing.count + 1, lastFailure: now })
    }
  } else {
    failureTracker.set(sessionID, { count: 1, lastFailure: now })
  }
}

const recordCompactionSuccess = (sessionID: string) => {
  failureTracker.delete(sessionID)
}

const getFailureCount = (sessionID: string) => {
  const entry = failureTracker.get(sessionID)
  if (!entry) return 0
  // Decay if outside TTL: treat as 0 and evict
  if (Date.now() - entry.lastFailure > FAILURE_TRACKER_TTL_MS) {
    failureTracker.delete(sessionID)
    return 0
  }
  return entry.count
}

export const make = (dependencies: Dependencies) => {
  const config = settings(dependencies.config)
  const compactAfterOverflow = Effect.fn("SessionCompaction.compactAfterOverflow")(function* (input: Input) {
    // Circuit breaker: stop retrying irrecoverable sessions (Claude: 3 consecutive failures)
    if (getFailureCount(input.sessionID) >= MAX_CONSECUTIVE_COMPACTION_FAILURES) {
      yield* Effect.logWarning("Compaction circuit breaker triggered", {
        sessionID: input.sessionID,
        failures: getFailureCount(input.sessionID),
      })
      return false
    }

    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
    let selected = select(input.entries, config.tokens)
    const previousSummary = input.entries.find((entry) => entry.message.type === "compaction")?.message
    if (!selected || (selected.head.length === 0 && previousSummary?.type !== "compaction")) return false

    let summaryPrompt = buildPrompt({
      previousSummary: previousSummary?.type === "compaction" ? previousSummary.summary : undefined,
      context: [previousSummary?.type === "compaction" ? previousSummary.recent : "", selected.head].filter(Boolean),
    })
    const summaryOutput = Math.min(output || SUMMARY_OUTPUT_TOKENS, COMPACT_MAX_OUTPUT_TOKENS)

    // PTL retry loop: truncate oldest turns if summary prompt doesn't fit (like Claude's truncateHeadForPTLRetry)
    let headForPrompt = selected.head
    let ptlRetries = 0
    const MAX_PTL_RETRIES = 3
    while (Token.estimate(summaryPrompt) > context - summaryOutput && ptlRetries < MAX_PTL_RETRIES) {
      const requiredReduction = Token.estimate(summaryPrompt) - (context - summaryOutput)
      const truncated = truncateHeadForPTLRetry(headForPrompt, requiredReduction)
      if (!truncated) break
      headForPrompt = truncated
      // Re-select recent stays same, only head truncated
      selected = { head: headForPrompt, recent: selected.recent }
      summaryPrompt = buildPrompt({
        previousSummary: previousSummary?.type === "compaction" ? previousSummary.summary : undefined,
        context: [previousSummary?.type === "compaction" ? previousSummary.recent : "", headForPrompt].filter(Boolean),
      })
      ptlRetries++
      yield* Effect.logInfo("Compaction PTL retry", { retry: ptlRetries, requiredReduction, newHeadLength: headForPrompt.length })
    }

    if (Token.estimate(summaryPrompt) > context - summaryOutput) {
      recordCompactionFailure(input.sessionID)
      return false
    }

    // Post-compact file/skill restoration tracking (Claude: up to 5 files * 5k tokens, 25k skills)
    // Extract recently read file paths and skills from recent context for hinting
    const recentFilePaths = extractRecentFilePaths(selected.recent)
    const recentSkillNames = extractRecentSkillNames(selected.recent)
    let enrichedRecent = selected.recent
    if (recentFilePaths.length > 0) {
      enrichedRecent += `\n\n[Recently accessed files (consider re-reading fresh if needed, budget ${POST_COMPACT_TOKEN_BUDGET} tokens total, ${POST_COMPACT_MAX_TOKENS_PER_FILE} per file): ${recentFilePaths.join(", ")}]`
    }
    if (recentSkillNames.length > 0) {
      enrichedRecent += `\n\n[Recently used skills (budget ${POST_COMPACT_SKILLS_TOKEN_BUDGET} tokens, ${POST_COMPACT_MAX_TOKENS_PER_SKILL} per skill): ${recentSkillNames.join(", ")}]`
    }

    const messageID = SessionMessage.ID.create()
    yield* dependencies.events.publish(SessionEvent.Compaction.Started, {
      sessionID: input.sessionID,
      messageID,
      timestamp: yield* DateTime.now,
      reason: "auto",
    })

    const chunks: string[] = []
    let failed = false
    const summarized = yield* dependencies.llm
      .stream(
        LLM.request({
          model: input.model,
          messages: [Message.user(summaryPrompt)],
          tools: [],
          generation: { maxTokens: summaryOutput },
        }),
      )
      .pipe(
        Stream.runForEach((event) => {
          if (LLMEvent.is.providerError(event)) failed = true
          if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
          return Effect.void
        }),
        Effect.as(true),
        Effect.catchTag("LLM.Error", () => Effect.succeed(false)),
      )
    const rawSummary = chunks.join("")
    if (!summarized || failed || !rawSummary.trim()) {
      recordCompactionFailure(input.sessionID)
      return false
    }
    const summary = formatCompactSummary(rawSummary)
    if (!summary) {
      recordCompactionFailure(input.sessionID)
      return false
    }
    yield* dependencies.events.publish(SessionEvent.Compaction.Ended, {
      sessionID: input.sessionID,
      messageID,
      timestamp: yield* DateTime.now,
      reason: "auto",
      text: summary,
      recent: enrichedRecent,
    })
    recordCompactionSuccess(input.sessionID)
    return true
  })
  const compactIfNeeded = Effect.fn("SessionCompaction.compactIfNeeded")(function* (input: Input) {
    if (!config.auto) return false
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
    const estimatedTokens = estimate({ system: input.request.system, messages: input.request.messages, tools: input.request.tools })
    const warningState = calculateTokenWarningState(estimatedTokens, context, output)

    // Wire warning state: log when above warning threshold (like Claude's TokenWarning.tsx)
    if (warningState.isAboveWarning && !warningState.shouldAutoCompact) {
      yield* Effect.logInfo("Compaction warning threshold reached", {
        sessionID: input.sessionID,
        percentUsed: warningState.percentUsed,
        percentRemaining: warningState.percentRemaining,
        tokenCount: estimatedTokens,
        autoThreshold: warningState.autoThreshold,
      })
    }

    if (estimatedTokens <= context - Math.max(output, config.buffer)) return false
    return yield* compactAfterOverflow(input)
  })
  return {
    compactIfNeeded,
    compactAfterOverflow,
  }
}
