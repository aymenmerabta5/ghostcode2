import type { TextareaRenderable } from "@opentui/core"
import type { WorkflowInfo } from "@opencode-ai/sdk/v2"
import type { AutocompleteOption } from "./autocomplete"

type WorkflowClient = {
  list: () => Promise<{ data?: WorkflowInfo[]; error?: unknown }>
}

export type WorkflowArgContext = {
  workflow: string
  query: string
  used: Set<string>
}

export const WORKFLOW_COMMAND_PREFIX = "/workflow "
const WORKFLOW_COMMAND_PATTERN = /^\/workflow\s+(\S*)$/
const WORKFLOW_ARG_PATTERN = /^\/workflow\s+(\S+)(?:\s+(.*))?$/
const WORKFLOW_COMMAND_ALIASES = ["/workflow "]

export function workflowNameQuery(input: string, cursorOffset: number) {
  return input.slice(0, cursorOffset).match(WORKFLOW_COMMAND_PATTERN)?.[1]
}

export function isWorkflowNameInput(input: string, cursorOffset: number) {
  return workflowNameQuery(input, cursorOffset) !== undefined
}

export function isWorkflowCommandInput(input: string) {
  return WORKFLOW_COMMAND_ALIASES.some((prefix) => input.startsWith(prefix))
}

function workflowAutocompleteIndex(ctx: { query: string }, cursorOffset: number) {
  return cursorOffset - ctx.query.length - 1
}

export function workflowAutocompleteTriggerIndex(input: string, cursorOffset: number) {
  if (isWorkflowNameInput(input, cursorOffset)) return WORKFLOW_COMMAND_PREFIX.length - 1
  const arg = workflowArgContext(input, cursorOffset)
  if (arg) return workflowAutocompleteIndex(arg, cursorOffset)
}

function tokenizeWorkflowArgs(input: string) {
  const tokens: { text: string; incomplete: boolean }[] = []
  let current = ""
  let quote: '"' | "'" | undefined
  let escaped = false
  let incomplete = false
  const flush = () => {
    if (current === "" && !incomplete) return
    tokens.push({ text: current, incomplete })
    current = ""
    incomplete = false
  }
  for (const char of input) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === "\\" && quote) {
      current += char
      escaped = true
      continue
    }
    if (quote) {
      current += char
      if (char === quote) quote = undefined
      else incomplete = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      incomplete = true
      current += char
      continue
    }
    if (/\s/.test(char)) {
      flush()
      continue
    }
    current += char
  }
  flush()
  return tokens
}

function workflowArgName(token: string) {
  return token.match(/^-{0,2}([^=\s]+)=/)?.[1] ?? token.match(/^-{0,2}([^=\s]+)$/)?.[1]
}

export function workflowArgContext(input: string, cursorOffset: number): WorkflowArgContext | undefined {
  const beforeCursor = input.slice(0, cursorOffset)
  const match = beforeCursor.match(WORKFLOW_ARG_PATTERN)
  if (!match || match[2] === undefined) return

  const trailingSpace = /\s$/.test(beforeCursor)
  const tokens = tokenizeWorkflowArgs(match[2])
  const current = trailingSpace ? "" : (tokens.at(-1)?.text ?? "")
  if (current.includes("=")) return

  return {
    workflow: match[1],
    query: current,
    used: new Set(
      tokens
        .slice(0, trailingSpace ? tokens.length : -1)
        .map((token) => workflowArgName(token.text))
        .filter((name): name is string => Boolean(name)),
    ),
  }
}

export function workflowNameOptions(input: TextareaRenderable, workflows: WorkflowInfo[]): AutocompleteOption[] {
  return workflows.map(
    (workflow): AutocompleteOption => ({
      display: workflow.name,
      value: workflow.name,
      description: workflow.meta.description ?? workflow.meta.name,
      onSelect: () => {
        const cursorOffset = input.cursorOffset
        input.cursorOffset = WORKFLOW_COMMAND_PREFIX.length
        const start = input.logicalCursor
        input.cursorOffset = cursorOffset
        const end = input.logicalCursor
        input.deleteRange(start.row, start.col, end.row, end.col)
        input.insertText(`${workflow.name} `)
        input.cursorOffset = Bun.stringWidth(`${WORKFLOW_COMMAND_PREFIX}${workflow.name} `)
      },
    }),
  )
}

export function workflowCommandOptions(
  workflows: WorkflowInfo[],
  existingCommandNames: Set<string>,
): AutocompleteOption[] {
  return workflows
    .filter((workflow) => workflow.valid !== false && !existingCommandNames.has(workflow.name))
    .map((workflow) => ({
      display: `/${workflow.name}`,
      value: workflow.name,
      description: workflow.meta.description ?? workflow.meta.name,
    }))
}

export function reservedSlashNames(
  slashes: readonly { display: string; aliases?: readonly string[] }[],
  serverCommands: readonly { name: string; source?: string }[],
): Set<string> {
  const strip = (display: string) => display.replace(/^\//, "").replace(/:mcp$/, "")
  const names = new Set<string>(["workflow", "workflows"])
  for (const slash of slashes) {
    names.add(strip(slash.display))
    for (const alias of slash.aliases ?? []) names.add(strip(alias))
  }
  for (const command of serverCommands) {
    if (command.source === "workflow") continue
    names.add(strip(command.name))
  }
  return names
}

export function workflowCommandOption(input: TextareaRenderable): AutocompleteOption {
  return {
    display: "/workflow",
    description: "Start a workflow by name",
    onSelect: () => {
      const cursor = input.logicalCursor
      input.deleteRange(0, 0, cursor.row, cursor.col)
      input.insertText(WORKFLOW_COMMAND_PREFIX)
      input.cursorOffset = Bun.stringWidth(WORKFLOW_COMMAND_PREFIX)
    },
  }
}

function replaceArgQuery(input: TextareaRenderable, ctx: WorkflowArgContext, text: string, cursorBack: number) {
  const startOffset = input.cursorOffset - ctx.query.length
  const cursorOffset = input.cursorOffset
  input.cursorOffset = startOffset
  const start = input.logicalCursor
  input.cursorOffset = cursorOffset
  const end = input.logicalCursor
  input.deleteRange(start.row, start.col, end.row, end.col)
  input.insertText(text)
  input.cursorOffset = startOffset + Bun.stringWidth(text) - cursorBack
}

export function workflowArgOptions(
  input: TextareaRenderable,
  ctx: WorkflowArgContext,
  workflow: WorkflowInfo | undefined,
): AutocompleteOption[] {
  const declared = workflow?.meta.arguments ?? {}
  const options = Object.entries(declared)
    .filter(([name]) => !ctx.used.has(name))
    .map(
      ([name, argument]): AutocompleteOption => ({
        display: `${name}=`,
        value: name,
        description: [
          argument.type,
          argument.default === undefined ? undefined : `default: ${String(argument.default)}`,
          argument.description,
        ]
          .filter(Boolean)
          .join(" ┬À "),
        onSelect: () => {
          const text = argument.type === "string" ? `${name}=""` : `${name}=`
          replaceArgQuery(input, ctx, text, argument.type === "string" ? 1 : 0)
        },
      }),
    )
  if (declared["budget"] === undefined && !ctx.used.has("budget")) {
    options.push({
      display: "budget=",
      value: "budget",
      description: "reserved ┬À USD cost cap for this run",
      onSelect: () => replaceArgQuery(input, ctx, "budget=", 0),
    })
  }
  return options
}

export function workflowOptions(
  input: TextareaRenderable,
  workflows: WorkflowInfo[],
  inputState: {
    arg: WorkflowArgContext | undefined
    name: string | undefined
  },
) {
  if (inputState.arg) {
    return workflowArgOptions(
      input,
      inputState.arg,
      workflows.find((item) => item.name === inputState.arg?.workflow),
    )
  }
  if (inputState.name !== undefined) return workflowNameOptions(input, workflows)
}

export async function listWorkflowInfos(workflow: WorkflowClient, enabled: boolean) {
  if (!enabled) return []
  const result = await workflow.list()
  if (result.error || !result.data) return []
  return result.data.filter((workflow) => workflow.valid !== false)
}

export type WorkflowArgDeclaration = Record<string, { type?: string }>

export function parseWorkflowArgs(input: string, declaration: WorkflowArgDeclaration = {}) {
  return Object.fromEntries(
    tokenizeWorkflowArgs(input).flatMap((token) => {
      const eq = token.text.indexOf("=")
      const name = (eq === -1 ? token.text : token.text.slice(0, eq)).replace(/^--?/, "")
      if (!name) return []
      const raw = eq === -1 ? "true" : token.text.slice(eq + 1)
      const value =
        (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) ||
        (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2)
          ? raw.slice(1, -1).replace(/\\(["'\\])/g, "$1")
          : raw
      if (declaration[name]?.type !== "number") return [[name, value]]
      const numeric = Number(value)
      return [[name, Number.isFinite(numeric) && value.trim() !== "" ? numeric : value]]
    }),
  )
}

export function extractReservedBudget(
  args: Record<string, unknown>,
  declaration: WorkflowArgDeclaration = {},
): { args: Record<string, unknown>; budget?: number; error?: string } {
  if (declaration["budget"] !== undefined) return { args }
  if (!("budget" in args)) return { args }
  const raw = String(args["budget"])
  const bare = raw.replace(/^\$/, "")
  const numeric = Number(bare)
  if (bare.trim() === "" || !Number.isFinite(numeric) || numeric < 0) {
    return { args, error: `Invalid budget value: ${raw}` }
  }
  const { budget: _, ...rest } = args
  return { args: rest, budget: numeric }
}
