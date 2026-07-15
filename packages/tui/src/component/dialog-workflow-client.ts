import type { Event, WorkflowRun } from "@opencode-ai/sdk/v2"
import type { useSDK } from "../context/sdk"

export const WORKFLOW_RUN_UPDATED = "workflow.run.updated"
export const WORKFLOW_RUN_FINISHED = "workflow.run.finished"

export type WorkflowRunEventMember = Extract<
  Event,
  { type: typeof WORKFLOW_RUN_UPDATED | typeof WORKFLOW_RUN_FINISHED }
>

export type WorkflowRunEventData = WorkflowRunEventMember["properties"]

export type WorkflowRunEvent = {
  kind: "updated" | "finished"
  run: WorkflowRunEventData
}

export type PendingQuestion = NonNullable<WorkflowRun["pending_question"]>

export function asWorkflowRunEvent(event: Event): WorkflowRunEvent | undefined {
  if (event.type !== WORKFLOW_RUN_UPDATED && event.type !== WORKFLOW_RUN_FINISHED) return undefined
  return {
    kind: event.type === WORKFLOW_RUN_FINISHED ? "finished" : "updated",
    run: event.properties,
  }
}

export type AnswerResult =
  | { type: "ok"; run: WorkflowRun }
  | { type: "not_found" }
  | { type: "no_question" }
  | { type: "error"; message: string }

export type AnswerInput = {
  id: string
  answer: string
  permissionSessionID?: string
}

export type WorkflowAnswerClient = {
  client: ReturnType<typeof useSDK>["client"]
  directory?: string
}

export async function answerWorkflowRun(sdk: WorkflowAnswerClient, input: AnswerInput): Promise<AnswerResult> {
  const payload: { answer: string; permissionSessionID?: string } = { answer: input.answer }
  if (input.permissionSessionID !== undefined) payload.permissionSessionID = input.permissionSessionID
  try {
    const result = await sdk.client.workflow.answer({
      id: input.id,
      directory: sdk.directory,
      workflowAnswerPayload: payload,
    })
    if (result.data) return { type: "ok", run: result.data }
    const status = result.response.status
    if (status === 404) return { type: "not_found" }
    if (status === 409) return { type: "no_question" }
    return { type: "error", message: `unexpected status ${status}` }
  } catch (error) {
    return { type: "error", message: error instanceof Error ? error.message : String(error) }
  }
}
