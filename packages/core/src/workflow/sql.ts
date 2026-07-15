import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"

export type WorkflowDefinitionRow = {
  name: string
  path: string
  meta: {
    name: string
    description?: string
    whenToUse?: string
    phases?: { title: string; detail?: string; model?: string }[]
    arguments?: Record<string, { type?: string; default?: unknown; description?: string }>
  }
  source?: string
  temporary?: boolean
}

export type WorkflowLogRow = {
  time: number
  phase?: string
  message: string
}

export type WorkflowAgentRow = {
  id: string
  status: "running" | "completed" | "failed" | "skipped"
  started_at: number
  completed_at?: number
  phase?: string
  agent?: string
  label?: string
  model?: string
  session_id?: string
  message_id?: string
  worktree?: string
  prompt: string
  output?: string
  cost?: number
  tokens?: {
    total?: number
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  error?: string
  cached?: boolean
  kind?: "agent" | "question"
  answer?: string
}

export const WorkflowRunTable = sqliteTable(
  "workflow_run",
  {
    id: text().primaryKey(),
    session_id: text(),
    directory: text().notNull().default(""),
    workflow: text().notNull(),
    status: text()
      .$type<"running" | "completed" | "failed" | "cancelled" | "interrupted" | "paused">()
      .notNull(),
    started_at: integer().notNull(),
    completed_at: integer(),
    current_phase: text(),
    args: text({ mode: "json" }).$type<Record<string, unknown>>(),
    definition: text({ mode: "json" }).$type<WorkflowDefinitionRow>(),
    logs: text({ mode: "json" }).notNull().$type<WorkflowLogRow[]>(),
    agents: text({ mode: "json" }).notNull().$type<WorkflowAgentRow[]>(),
    result: text(),
    error: text(),
    resume_of: text(),
    pending_question: text({ mode: "json" }).$type<{
      question: string
      options?: string[]
      asked_at: number
    }>(),
    ...Timestamps,
  },
  (table) => [
    index("workflow_run_started_at_idx").on(table.started_at),
    index("workflow_run_status_started_at_idx").on(table.status, table.started_at),
  ],
)
