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

export class InvalidPhaseError extends Schema.TaggedErrorClass<InvalidPhaseError>()("WorkflowInvalidPhaseError", {
  phase: Schema.String,
  declared: Schema.Array(Schema.String),
  message: Schema.String,
}) {}

export class CancelledError extends Error {
  readonly _tag = "WorkflowCancelledError"
  constructor() {
    super("Workflow cancelled")
    this.name = "WorkflowCancelledError"
  }
}

export class GuideFullError extends Schema.TaggedErrorClass<GuideFullError>()("WorkflowGuideFullError", {
  message: Schema.String,
  maxLines: Schema.Number,
  currentLines: Schema.Number,
}) {}

export class MergeConflictError extends Schema.TaggedErrorClass<MergeConflictError>()("WorkflowMergeConflictError", {
  message: Schema.String,
  branch: Schema.String,
  files: Schema.Array(Schema.String),
}) {}
