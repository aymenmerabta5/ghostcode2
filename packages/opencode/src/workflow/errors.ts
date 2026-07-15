import { Schema } from "effect"

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("WorkflowNotFoundError", {
  name: Schema.String,
}) {}

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("WorkflowInvalidError", {
  path: Schema.String,
  message: Schema.String,
}) {}

export class SaveConflictError extends Schema.TaggedErrorClass<SaveConflictError>()("WorkflowSaveConflictError", {
  name: Schema.String,
  path: Schema.String,
}) {}

export class StructuredOutputError extends Schema.TaggedErrorClass<StructuredOutputError>()(
  "WorkflowStructuredOutputError",
  { message: Schema.String },
) {}

export class BudgetExceededError extends Schema.TaggedErrorClass<BudgetExceededError>()(
  "WorkflowBudgetExceededError",
  {
    message: Schema.String,
    budget: Schema.Finite,
    spent: Schema.Finite,
    unit: Schema.optional(Schema.Literals(["usd", "tokens"])),
  },
) {}

export class AgentLimitError extends Schema.TaggedErrorClass<AgentLimitError>()("WorkflowAgentLimitError", {
  message: Schema.String,
  limit: Schema.Finite,
  started: Schema.Finite,
}) {}

export class CancelledError extends Error {
  readonly _tag = "WorkflowCancelledError"
  constructor() {
    super("Workflow cancelled")
    this.name = "WorkflowCancelledError"
  }
}
