import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { BackgroundJob } from "@/background/job"
import DESCRIPTION from "./task-output.txt"

export const Parameters = Schema.Struct({
  task_id: Schema.String.annotate({ description: "ID of the job (supports prefix matching)" }),
  timeout: Schema.optional(Schema.Number).annotate({
    description: "How long to wait in ms (default 120000, max 600000). Use 0 to peek without waiting",
  }),
  tail: Schema.optional(Schema.Number).annotate({
    description: "Number of last lines to return (default 100, max 1000)",
  }),
  full: Schema.optional(Schema.Boolean).annotate({ description: "If true, returns full output bounded to 50k chars" }),
  filter: Schema.optional(Schema.String).annotate({ description: "Optional substring to filter output lines (case-insensitive)" }),
})

type Params = Schema.Schema.Type<typeof Parameters>

const MAX_FULL_CHARS = 50_000
const DEFAULT_TAIL = 100
const DEFAULT_TIMEOUT = 120_000

const HOST_PORT_RE = /\b(localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b/g
const URL_RE = /https?:\/\/[^\s]+/g

function detectPortsAndUrls(text: string) {
  const ports = new Set<string>()
  const urls = new Set<string>()
  let m: RegExpExecArray | null

  HOST_PORT_RE.lastIndex = 0
  while ((m = HOST_PORT_RE.exec(text)) !== null) {
    ports.add(`${m[1]}:${m[2]}`)
  }

  URL_RE.lastIndex = 0
  while ((m = URL_RE.exec(text)) !== null) {
    // Trim trailing punctuation that often follows URLs in logs
    const cleaned = m[0].replace(/[),.;!]+$/, "")
    urls.add(cleaned)
  }

  return {
    detectedPorts: Array.from(ports),
    detectedUrls: Array.from(urls),
  }
}

function applyFilter(lines: string[], filter?: string) {
  if (!filter) return lines
  const lower = filter.toLowerCase()
  return lines.filter((l) => l.toLowerCase().includes(lower))
}

function sliceTail(text: string, tailLines: number, filter?: string): string {
  if (!text) return ""
  let lines = text.split("\n")
  lines = applyFilter(lines, filter)
  if (lines.length > tailLines) lines = lines.slice(-tailLines)
  return lines.join("\n")
}

function sliceFull(text: string, filter?: string): { content: string; truncated: boolean } {
  if (!text) return { content: "", truncated: false }
  let processed = text
  if (filter) {
    const lines = applyFilter(text.split("\n"), filter)
    processed = lines.join("\n")
  }
  if (processed.length > MAX_FULL_CHARS) {
    return {
      content: processed.slice(-MAX_FULL_CHARS) + `\n\n... truncated, full was ${processed.length} chars, showing last ${MAX_FULL_CHARS} ...`,
      truncated: true,
    }
  }
  return { content: processed, truncated: false }
}

function formatOutput(input: {
  id: string
  title?: string
  type: string
  status: string
  started_at: number
  completed_at?: number
  output: string
  timedOut?: boolean
  isPeek?: boolean
  detectedPorts: string[]
  detectedUrls: string[]
  filter?: string
  tail?: number
  full?: boolean
}) {
  const duration = Math.round((Date.now() - input.started_at) / 1000)
  const lines: string[] = []
  lines.push(`Task: ${input.id}`)
  if (input.title) lines.push(`Title: ${input.title}`)
  lines.push(`Type: ${input.type}`)
  lines.push(`Status: ${input.status}`)
  lines.push(`Duration: ${duration}s`)
  if (input.timedOut) lines.push(`TimedOut: true`)
  if (input.isPeek) lines.push(`Peek: true (no wait, snapshot only)`)
  if (input.filter) lines.push(`Filter: "${input.filter}"`)
  if (input.full) lines.push(`Full: true (bounded ${MAX_FULL_CHARS} chars)`)
  else lines.push(`Tail: ${input.tail ?? DEFAULT_TAIL} lines`)

  if (input.detectedPorts.length > 0) lines.push(`Detected ports: ${input.detectedPorts.join(", ")}`)
  if (input.detectedUrls.length > 0) lines.push(`Detected URLs: ${input.detectedUrls.join(", ")}`)

  lines.push("")
  lines.push("--- Output ---")
  lines.push(input.output || "(no output yet)")

  if (input.timedOut) {
    lines.push("")
    lines.push("Task still running. Do NOT spam background_output in a loop.")
    lines.push("Work on other tasks that don't overlap with this job's files/topics.")
    lines.push("You will be notified when it finishes, or check again later with a longer timeout.")
  }

  if (input.status === "running" && !input.timedOut && !input.isPeek) {
    lines.push("")
    lines.push("Note: job completed while waiting.")
  }

  return lines.join("\n")
}

function makeExecute(id: string) {
  return Tool.define(
    id,
    Effect.gen(function* () {
      const bg = yield* BackgroundJob.Service

      return {
        description: DESCRIPTION,
        parameters: Parameters,
        execute: (params: Params) =>
          Effect.gen(function* () {
            const rawTimeout = params.timeout ?? DEFAULT_TIMEOUT
            const timeout = Math.max(0, Math.min(600000, rawTimeout))
            const rawTail = params.tail ?? DEFAULT_TAIL
            const tailLines = Math.max(1, Math.min(1000, rawTail))
            const full = params.full ?? false

            // Resolve prefix via list
            const all = yield* bg.list()
            const exact = all.find((j) => j.id === params.task_id)
            let resolvedId: string
            if (exact) {
              resolvedId = exact.id
            } else {
              const prefixed = all.filter((j) => j.id.startsWith(params.task_id) || j.id.slice(0, 8) === params.task_id)
              if (prefixed.length === 0) {
                return {
                  title: "Job not found",
                  metadata: { error: true, task_id: params.task_id },
                  output: `Job not found: ${params.task_id}. Use background_list to see running jobs.`,
                } as any
              }
              if (prefixed.length > 1) {
                return {
                  title: "Ambiguous job ID",
                  metadata: { error: true, task_id: params.task_id },
                  output: `Ambiguous job ID: ${params.task_id} matches ${prefixed.length} jobs: ${prefixed.map((j) => j.id.slice(0, 8)).join(", ")}. Use more characters to disambiguate.`,
                } as any
              }
              resolvedId = prefixed[0].id
            }

            let job = yield* bg.get(resolvedId)
            if (!job) {
              return {
                title: "Job not found",
                metadata: { error: true, task_id: params.task_id },
                output: `Job not found: ${params.task_id}. Use background_list to see running jobs.`,
              } as any
            }

            const prepare = (rawOutput: string) => {
              const detected = detectPortsAndUrls(rawOutput)
              let finalOutput: string
              let truncated = false
              if (full) {
                const r = sliceFull(rawOutput, params.filter)
                finalOutput = r.content
                truncated = r.truncated
              } else {
                finalOutput = sliceTail(rawOutput, tailLines, params.filter)
              }
              return { ...detected, finalOutput, truncated }
            }

            // If not running, return immediately
            if (job.status !== "running") {
              const raw = job.output ?? job.error ?? ""
              const { detectedPorts, detectedUrls, finalOutput } = prepare(raw)
              const out = formatOutput({
                id: job.id,
                title: job.title,
                type: job.type,
                status: job.status,
                started_at: job.started_at,
                completed_at: job.completed_at,
                output: finalOutput,
                detectedPorts,
                detectedUrls,
                filter: params.filter,
                tail: tailLines,
                full,
              })
              return {
                title: job.title ?? job.id,
                metadata: {
                  task_id: job.id,
                  status: job.status,
                  duration: Math.round((Date.now() - job.started_at) / 1000),
                  detectedPorts,
                  detectedUrls,
                  timedOut: false,
                },
                output: out,
              }
            }

            // Running
            if (timeout === 0) {
              const raw = job.output ?? ""
              const { detectedPorts, detectedUrls, finalOutput } = prepare(raw)
              const out = formatOutput({
                id: job.id,
                title: job.title,
                type: job.type,
                status: job.status,
                started_at: job.started_at,
                output: finalOutput,
                timedOut: false,
                isPeek: true,
                detectedPorts,
                detectedUrls,
                filter: params.filter,
                tail: tailLines,
                full,
              })
              return {
                title: job.title ?? job.id,
                metadata: {
                  task_id: job.id,
                  status: job.status,
                  duration: Math.round((Date.now() - job.started_at) / 1000),
                  detectedPorts,
                  detectedUrls,
                  timedOut: true,
                },
                output: out,
              }
            }

            const waited = yield* bg.wait({ id: job.id, timeout })

            if (waited.timedOut) {
              // Still running
              const current = waited.info ?? (yield* bg.get(job.id)) ?? job
              const raw = current.output ?? ""
              const { detectedPorts, detectedUrls, finalOutput } = prepare(raw)
              const out = formatOutput({
                id: current.id,
                title: current.title,
                type: current.type,
                status: current.status,
                started_at: current.started_at,
                output: finalOutput,
                timedOut: true,
                detectedPorts,
                detectedUrls,
                filter: params.filter,
                tail: tailLines,
                full,
              })
              return {
                title: current.title ?? current.id,
                metadata: {
                  task_id: current.id,
                  status: current.status,
                  duration: Math.round((Date.now() - current.started_at) / 1000),
                  detectedPorts,
                  detectedUrls,
                  timedOut: true,
                },
                output: out,
              }
            }

            // Completed during wait
            const finalInfo = waited.info ?? (yield* bg.get(job.id))
            if (!finalInfo) {
              return {
                title: "Job not found",
                metadata: { error: true, task_id: params.task_id },
                output: `Job not found after wait: ${params.task_id}. Use background_list to see running jobs.`,
              } as any
            }
            const raw = finalInfo.output ?? finalInfo.error ?? ""
            const { detectedPorts, detectedUrls, finalOutput } = prepare(raw)
            const out = formatOutput({
              id: finalInfo.id,
              title: finalInfo.title,
              type: finalInfo.type,
              status: finalInfo.status,
              started_at: finalInfo.started_at,
              completed_at: finalInfo.completed_at,
              output: finalOutput,
              timedOut: false,
              detectedPorts,
              detectedUrls,
              filter: params.filter,
              tail: tailLines,
              full,
            })
            return {
              title: finalInfo.title ?? finalInfo.id,
              metadata: {
                task_id: finalInfo.id,
                status: finalInfo.status,
                duration: Math.round((Date.now() - finalInfo.started_at) / 1000),
                detectedPorts,
                detectedUrls,
                timedOut: false,
              },
              output: out,
            }
          }),
      } as any
    }),
  )
}

export const TaskOutputTool = makeExecute("task_output")
export const BackgroundOutputTool = makeExecute("background_output")
