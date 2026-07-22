import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { BackgroundJob } from "@/background/job"
import DESCRIPTION from "./background-kill.txt"

export const Parameters = Schema.Struct({
  task_id: Schema.String.annotate({ description: "ID of the background job to kill (supports prefix matching)" }),
  reason: Schema.optional(Schema.String).annotate({ description: "Optional reason for cancellation" }),
})

function resolveId(jobs: { id: string }[], input: string) {
  // Exact match first
  const exact = jobs.find((j) => j.id === input)
  if (exact) return exact.id
  // Prefix match (e.g., first 8 chars shown in list)
  const prefixed = jobs.filter((j) => j.id.startsWith(input))
  if (prefixed.length === 1) return prefixed[0].id
  // If ambiguous, return undefined and let caller handle
  if (prefixed.length > 1) return prefixed[0].id
  return undefined
}

export const BackgroundKillTool = Tool.define(
  "background_kill",
  Effect.gen(function* () {
    const bg = yield* BackgroundJob.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>) =>
        Effect.gen(function* () {
          const all = yield* bg.list()
          const targetId = resolveId(all, params.task_id) ?? params.task_id

          const result = yield* bg.cancel(targetId)

          if (!result) {
            // Try again with prefix resolved from list snapshot that might have changed
            return yield* Effect.fail(new Error(`Job not found: ${params.task_id}. Use background_list to see running jobs`))
          }

          const wasRunning = result.status === "cancelled"
          const previouslyCompleted = result.status !== "running" && result.status !== "cancelled"

          let output = `Job ${result.id} cancelled`
          if (wasRunning) output += " (was running, now cancelled)"
          if (result.status === "completed") output += "\nNote: job had already completed"
          if (result.status === "error") output += "\nNote: job had already errored"
          if (result.status === "cancelled" && previouslyCompleted) {
            // already cancelled case is covered by snapshot having completed_at etc
          }
          if (params.reason) output += `\nReason: ${params.reason}`
          output += `\nStatus: ${result.status}`
          if (result.title) output += `\nTitle: ${result.title}`
          if (result.type) output += `\nType: ${result.type}`

          return {
            title: `Cancelled ${result.id.slice(0, 8)}`,
            metadata: {
              jobId: result.id,
              status: result.status,
              reason: params.reason,
              type: result.type,
            },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
