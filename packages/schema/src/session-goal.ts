export * as SessionGoal from "./session-goal"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { SessionID } from "./session-id"
import { optional } from "./schema"

export const Status = Schema.Literals(["active", "paused", "completed"])
export type Status = Schema.Schema.Type<typeof Status>

export const Info = Schema.Struct({
  text: Schema.String.annotate({ description: "The active goal for this session" }),
  status: Status,
  budgetTokens: optional(Schema.Number).annotate({ description: "Optional token budget for the goal" }),
  tokensUsed: Schema.Number,
  timeMs: Schema.Number,
  startedAt: Schema.Number,
  pausedAt: optional(Schema.Number),
  completedAt: optional(Schema.Number),
  verification: optional(Schema.String),
}).annotate({ identifier: "Goal" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

const Updated = define({
  type: "goal.updated",
  schema: {
    sessionID: SessionID,
    goal: Schema.NullOr(Info),
  },
})
export const Event = { Updated, Definitions: inventory(Updated) }
