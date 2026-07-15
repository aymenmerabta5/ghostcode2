import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Goal } from "../session/goal"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["update", "pause", "resume", "complete"]).annotate({
    description:
      "complete: the goal is fully achieved (include verification) ÔÇö stops the loop. pause: you are blocked or need the user ÔÇö stops the loop. resume: keep pursuing. update: revise the goal text.",
  }),
  text: Schema.optional(Schema.String).annotate({ description: "New goal text (action=update)." }),
  verification: Schema.optional(Schema.String).annotate({
    description: "Concise evidence the goal was achieved (action=complete).",
  }),
})

type Metadata = {
  status?: "active" | "paused" | "completed"
}

export const GoalTool = Tool.define<typeof Parameters, Metadata, Goal.Service>(
  "goal",
  Effect.gen(function* () {
    const goals = yield* Goal.Service

    return {
      description:
        "Manage this session's goal and control the autonomous goal loop. Re-read the current goal from the <session-goal> block in the system prompt first. Call complete only once the goal is genuinely achieved, with a short verification of what was done ÔÇö this stops the loop. Call pause if you are blocked or need user input. Use sparingly.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const updated =
            params.action === "complete"
              ? yield* goals.update({
                  sessionID: ctx.sessionID,
                  status: "completed",
                  verification: params.verification,
                })
              : params.action === "pause"
                ? yield* goals.pause(ctx.sessionID)
                : params.action === "resume"
                  ? yield* goals.resume(ctx.sessionID)
                  : yield* goals.update({ sessionID: ctx.sessionID, text: params.text })

          const current = updated ?? (yield* goals.get(ctx.sessionID))
          return {
            title: current ? `goal ${current.status}` : "goal",
            output: current ? JSON.stringify(current) : "no active goal",
            metadata: { status: current?.status },
          } satisfies Tool.ExecuteResult<Metadata>
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
