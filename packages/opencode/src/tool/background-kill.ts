import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { BackgroundJob } from "@/background/job"
import DESCRIPTION from "./background-kill.txt"

export const Parameters = Schema.Struct({
  task_id: Schema.String.annotate({ description: "ID of the background job to kill (supports prefix matching)" }),
  reason: Schema.optional(Schema.String).annotate({ description: "Optional reason for cancellation" }),
})

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

          const exact = all.find((j) => j.id === params.task_id)
          let targetId: string | undefined
          if (exact) {
            targetId = exact.id
          } else {
            const prefixed = all.filter((j) => j.id.startsWith(params.task_id))
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
            targetId = prefixed[0].id
          }

          const result = yield* bg.cancel(targetId)

          if (!result) {
            return {
              title: "Job not found",
              metadata: { error: true, task_id: params.task_id },
              output: `Job not found: ${params.task_id}. Use background_list to see running jobs.`,
            } as any
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
        }),
    } as any
  }),
)
