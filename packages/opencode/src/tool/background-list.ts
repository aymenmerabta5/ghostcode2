import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { BackgroundJob } from "@/background/job"
import DESCRIPTION from "./background-list.txt"

function escapeCell(input: string) {
  // Collapse newlines and trim pipe-breaking
  return input.replace(/\|/g, "\\|").replace(/\n/g, " ").replace(/\r/g, "").trim()
}

export const BackgroundListTool = Tool.define(
  "background_list",
  Effect.gen(function* () {
    const bg = yield* BackgroundJob.Service

    return {
      description: DESCRIPTION,
      parameters: Schema.Struct({}),
      execute: (_params: {}, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const jobs = yield* bg.list()

          if (jobs.length === 0) {
            return {
              title: "Background jobs",
              metadata: { count: 0, jobs: [] as { id: string; type: string; status: string }[] },
              output: "No background jobs",
            }
          }

          const rows = jobs.map((j) => {
            const shortId = j.id.slice(0, 8)
            const durationSec = Math.round((Date.now() - j.started_at) / 1000)
            const rawTail = (j.output || j.error || "").slice(-100)
            const tail = escapeCell(rawTail) || "-"
            const title = escapeCell(j.title ?? "-") || "-"
            return `| ${shortId} | ${j.type} | ${title} | ${j.status} | ${durationSec}s | ${tail} |`
          })

          const tableHeader = "| id | type | title | status | duration | tail |"
          const separator = "|---|---|---|---|---|---|"
          const table = [tableHeader, separator, ...rows].join("\n")

          const output =
            table +
            "\n\nUse background_output {task_id} to see full logs, background_kill to stop" +
            "\nFull ids: " +
            jobs.map((j) => j.id).join(", ")

          return {
            title: "Background jobs",
            metadata: { count: jobs.length, jobs: jobs.map((j) => ({ id: j.id, type: j.type, status: j.status })) },
            output,
          }
        }),
    }
  }),
)
