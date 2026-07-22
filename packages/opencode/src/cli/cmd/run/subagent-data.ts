import type { Event, Message, Part, PermissionRequest, QuestionRequest, ToolPart } from "@opencode-ai/sdk/v2"
import * as Locale from "@/util/locale"
import {
  bootstrapSessionData,
  createSessionData,
  formatError,
  reduceSessionData,
  type SessionData,
} from "./session-data"
import type { FooterSubagentState, FooterSubagentTab, StreamCommit } from "./types"

export const SUBAGENT_BOOTSTRAP_LIMIT = 200
export const SUBAGENT_CALL_BOOTSTRAP_LIMIT = 80

const SUBAGENT_COMMIT_LIMIT = 80
const SUBAGENT_CALL_LIMIT = 32
const SUBAGENT_ROLE_LIMIT = 32
const SUBAGENT_ERROR_LIMIT = 16
const SUBAGENT_ECHO_LIMIT = 8

type SessionMessage = {
  parts: Part[]
}

type BootstrapChildMessage = SessionMessage & {
  info: Message
}

type Frame = {
  key: string
  commit: StreamCommit
}

type DetailState = {
  sessionID: string
  data: SessionData
  frames: Frame[]
}

export type BackgroundJobInfo = {
  id: string
  type: string
  title?: string
  status: "running" | "completed" | "error" | "cancelled"
  started_at: number
  completed_at?: number
  output?: string
  error?: string
  metadata?: Record<string, unknown>
}

export type SubagentData = {
  tabs: Map<string, FooterSubagentTab>
  details: Map<string, DetailState>
  background: Map<string, BackgroundJobInfo>
}

export type BootstrapSubagentInput = {
  data: SubagentData
  messages: SessionMessage[]
  children: Array<{ id: string; title?: string }>
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
}

function createDetail(sessionID: string): DetailState {
  return {
    sessionID,
    data: createSessionData({
      includeUserText: true,
    }),
    frames: [],
  }
}

function ensureDetail(data: SubagentData, sessionID: string) {
  const current = data.details.get(sessionID)
  if (current) {
    return current
  }

  const next = createDetail(sessionID)
  data.details.set(sessionID, next)
  return next
}

export function sameSubagentTab(a: FooterSubagentTab | undefined, b: FooterSubagentTab | undefined) {
  if (!a || !b) {
    return false
  }

  return (
    a.sessionID === b.sessionID &&
    a.partID === b.partID &&
    a.callID === b.callID &&
    a.label === b.label &&
    a.description === b.description &&
    a.status === b.status &&
    a.background === b.background &&
    a.title === b.title &&
    a.toolCalls === b.toolCalls &&
    a.lastUpdatedAt === b.lastUpdatedAt
  )
}

function sameQueue<T extends { id: string }>(left: T[], right: T[]) {
  return (
    left.length === right.length && left.every((item, index) => item.id === right[index]?.id && item === right[index])
  )
}

function queueSnapshot(data: SessionData) {
  return {
    permissions: data.permissions.slice(),
    questions: data.questions.slice(),
  }
}

function queueChanged(data: SessionData, before: ReturnType<typeof queueSnapshot>) {
  return !sameQueue(before.permissions, data.permissions) || !sameQueue(before.questions, data.questions)
}

function sameCommit(left: StreamCommit, right: StreamCommit) {
  return (
    left.kind === right.kind &&
    left.text === right.text &&
    left.phase === right.phase &&
    left.source === right.source &&
    left.messageID === right.messageID &&
    left.partID === right.partID &&
    left.tool === right.tool &&
    left.interrupted === right.interrupted &&
    left.toolState === right.toolState &&
    left.toolError === right.toolError
  )
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined
  }

  const next = value.trim()
  return next || undefined
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }

  return undefined
}

function inputLabel(input: Record<string, unknown>): string | undefined {
  const description = text(input.description)
  if (description) {
    return description
  }

  const command = text(input.command)
  if (command) {
    return command
  }

  const filePath = text(input.filePath) ?? text(input.filepath)
  if (filePath) {
    return filePath
  }

  const pattern = text(input.pattern)
  if (pattern) {
    return pattern
  }

  const query = text(input.query)
  if (query) {
    return query
  }

  const url = text(input.url)
  if (url) {
    return url
  }

  const path = text(input.path)
  if (path) {
    return path
  }

  const prompt = text(input.prompt)
  if (prompt) {
    return prompt
  }

  return undefined
}

function stateTitle(part: ToolPart) {
  return text("title" in part.state ? part.state.title : undefined)
}

function callKey(messageID: string | undefined, callID: string | undefined): string | undefined {
  if (!messageID || !callID) {
    return undefined
  }

  return `${messageID}:${callID}`
}

function compactToolState(part: ToolPart): ToolPart["state"] {
  if (part.state.status === "pending") {
    return {
      status: "pending",
      input: part.state.input,
      raw: part.state.raw,
    }
  }

  if (part.state.status === "running") {
    return {
      status: "running",
      input: part.state.input,
      time: part.state.time,
      ...(part.state.metadata ? { metadata: part.state.metadata } : {}),
      ...(part.state.title ? { title: part.state.title } : {}),
    }
  }

  if (part.state.status === "completed") {
    return {
      status: "completed",
      input: part.state.input,
      output: part.state.output,
      title: part.state.title,
      metadata: part.state.metadata,
      time: part.state.time,
    }
  }

  return {
    status: "error",
    input: part.state.input,
    error: part.state.error,
    time: part.state.time,
    ...(part.state.metadata ? { metadata: part.state.metadata } : {}),
  }
}

function recent<T>(input: Iterable<T>, limit: number) {
  const list = [...input]
  return list.slice(Math.max(0, list.length - limit))
}

function copyMap<K, V>(source: Map<K, V>, keep: Set<K>) {
  const out = new Map<K, V>()
  for (const [key, value] of source) {
    if (!keep.has(key)) {
      continue
    }

    out.set(key, value)
  }
  return out
}

function compactToolPart(part: ToolPart): ToolPart {
  return {
    id: part.id,
    type: "tool",
    sessionID: part.sessionID,
    messageID: part.messageID,
    callID: part.callID,
    tool: part.tool,
    state: compactToolState(part),
    ...(part.metadata ? { metadata: part.metadata } : {}),
  }
}

function compactCommit(commit: StreamCommit): StreamCommit {
  if (!commit.part) {
    return commit
  }

  return {
    ...commit,
    part: compactToolPart(commit.part),
  }
}

function stateUpdatedAt(part: ToolPart) {
  if (!("time" in part.state)) {
    return Date.now()
  }

  const time = part.state.time
  if (!("end" in time)) {
    return time.start ?? Date.now()
  }

  return time.end ?? time.start ?? Date.now()
}

function metadata(part: ToolPart, key: string) {
  return ("metadata" in part.state ? part.state.metadata?.[key] : undefined) ?? part.metadata?.[key]
}

function taskStatus(part: ToolPart): FooterSubagentTab["status"] {
  if (part.state.status === "completed") {
    return "completed"
  }

  if (part.state.status === "error") {
    if (metadata(part, "interrupted") === true || text(part.state.error) === "Tool execution aborted") {
      return "cancelled"
    }

    return "error"
  }

  return "running"
}

function taskTab(part: ToolPart, sessionID: string): FooterSubagentTab {
  const label = Locale.titlecase(text(part.state.input.subagent_type) ?? "general")
  const description = text(part.state.input.description) ?? stateTitle(part) ?? inputLabel(part.state.input) ?? ""

  return {
    sessionID,
    partID: part.id,
    callID: part.callID,
    label,
    description,
    status: taskStatus(part),
    background: metadata(part, "background") === true,
    title: stateTitle(part),
    toolCalls: num(metadata(part, "toolcalls")) ?? num(metadata(part, "toolCalls")) ?? num(metadata(part, "calls")),
    lastUpdatedAt: stateUpdatedAt(part),
  }
}

function taskSessionID(part: ToolPart) {
  return text(metadata(part, "sessionId")) ?? text(metadata(part, "sessionID"))
}

function syncTaskTab(data: SubagentData, part: ToolPart, children?: Set<string>) {
  if (part.tool !== "task") {
    return false
  }

  const sessionID = taskSessionID(part)
  if (!sessionID) {
    return false
  }

  if (children && children.size > 0 && !children.has(sessionID)) {
    return false
  }

  const next = taskTab(part, sessionID)
  if (sameSubagentTab(data.tabs.get(sessionID), next)) {
    ensureDetail(data, sessionID)
    return false
  }

  data.tabs.set(sessionID, next)
  ensureDetail(data, sessionID)
  return true
}

function frameKey(commit: StreamCommit) {
  if (commit.partID) {
    return `${commit.kind}:${commit.partID}:${commit.phase}`
  }

  if (commit.messageID) {
    return `${commit.kind}:${commit.messageID}:${commit.phase}`
  }

  return `${commit.kind}:${commit.phase}:${commit.text}`
}

function limitFrames(detail: DetailState) {
  if (detail.frames.length <= SUBAGENT_COMMIT_LIMIT) {
    return
  }

  detail.frames.splice(0, detail.frames.length - SUBAGENT_COMMIT_LIMIT)
}

function mergeLiveCommit(current: StreamCommit, next: StreamCommit) {
  if (current.phase !== "progress" || next.phase !== "progress") {
    if (sameCommit(current, next)) {
      return current
    }

    return next
  }

  const merged = {
    ...current,
    ...next,
    text: current.text + next.text,
  }

  if (sameCommit(current, merged)) {
    return current
  }

  return merged
}

function appendCommits(detail: DetailState, commits: StreamCommit[]) {
  let changed = false

  for (const commit of commits.map(compactCommit)) {
    const key = frameKey(commit)
    const index = detail.frames.findIndex((item) => item.key === key)
    if (index === -1) {
      detail.frames.push({
        key,
        commit,
      })
      changed = true
      continue
    }

    const next = mergeLiveCommit(detail.frames[index].commit, commit)
    if (sameCommit(detail.frames[index].commit, next)) {
      continue
    }

    detail.frames[index] = {
      key,
      commit: next,
    }
    changed = true
  }

  if (changed) {
    limitFrames(detail)
  }

  return changed
}

function ensureBlockerTab(
  data: SubagentData,
  sessionID: string,
  title: string | undefined,
  kind: "permission" | "question",
) {
  const current = data.tabs.get(sessionID)
  if (current) {
    ensureDetail(data, sessionID)
    if (current.status !== "running") {
      return false
    }

    const next = {
      ...current,
      description: kind === "permission" ? "Pending permission" : "Pending question",
      status: "running" as const,
      title: current.title ?? title,
      lastUpdatedAt: Date.now(),
    }
    if (sameSubagentTab(current, next)) {
      return false
    }

    data.tabs.set(sessionID, next)
    return true
  }

  data.tabs.set(sessionID, {
    sessionID,
    partID: `bootstrap:${sessionID}`,
    callID: `bootstrap:${sessionID}`,
    label: text(title) ?? Locale.titlecase(kind),
    description: kind === "permission" ? "Pending permission" : "Pending question",
    status: "running",
    lastUpdatedAt: Date.now(),
  })
  ensureDetail(data, sessionID)
  return true
}

function isAbortedAssistantMessage(info: Message) {
  return info.role === "assistant" && info.error?.name === "MessageAbortedError"
}

function cancelSubagentTab(data: SubagentData, sessionID: string) {
  const current = data.tabs.get(sessionID)
  if (!current || current.status !== "running") {
    return false
  }

  const next = {
    ...current,
    status: "cancelled" as const,
    lastUpdatedAt: Date.now(),
  }
  if (sameSubagentTab(current, next)) {
    return false
  }

  data.tabs.set(sessionID, next)
  return true
}

function compactCallMap(detail: DetailState) {
  const keep = new Set(recent(detail.data.call.keys(), SUBAGENT_CALL_LIMIT))

  for (const request of detail.data.permissions) {
    const key = callKey(request.tool?.messageID, request.tool?.callID)
    if (key) {
      keep.add(key)
    }
  }

  for (const item of detail.frames) {
    const key = callKey(item.commit.part?.messageID, item.commit.part?.callID)
    if (key) {
      keep.add(key)
    }
  }

  return copyMap(detail.data.call, keep)
}

function compactEchoMap(data: SessionData, messageIDs: Set<string>) {
  const keys = new Set([...messageIDs, ...recent(data.echo.keys(), SUBAGENT_ECHO_LIMIT)])
  return copyMap(data.echo, keys)
}

function compactIDs(detail: DetailState) {
  return new Set(recent(detail.data.ids, SUBAGENT_COMMIT_LIMIT + SUBAGENT_ERROR_LIMIT))
}

function compactDetail(detail: DetailState) {
  const next = createSessionData({
    includeUserText: true,
  })
  const activePartIDs = new Set(detail.data.part.keys())
  const framePartIDs = new Set(detail.frames.flatMap((item) => (item.commit.partID ? [item.commit.partID] : [])))
  const partIDs = new Set([...activePartIDs, ...framePartIDs, ...detail.data.tools])
  const messageIDs = new Set([
    ...[...activePartIDs]
      .map((partID) => detail.data.msg.get(partID))
      .filter((item): item is string => typeof item === "string"),
    ...recent(detail.data.role.keys(), SUBAGENT_ROLE_LIMIT),
  ])

  next.announced = detail.data.announced
  next.permissions = detail.data.permissions
  next.questions = detail.data.questions
  next.ids = compactIDs(detail)
  next.tools = new Set([...detail.data.tools].filter((item) => partIDs.has(item)))
  next.call = compactCallMap(detail)
  next.role = copyMap(detail.data.role, messageIDs)
  next.msg = copyMap(detail.data.msg, activePartIDs)
  next.part = copyMap(detail.data.part, activePartIDs)
  next.text = copyMap(detail.data.text, activePartIDs)
  next.sent = copyMap(detail.data.sent, activePartIDs)
  next.end = new Set([...detail.data.end].filter((item) => activePartIDs.has(item)))
  next.echo = compactEchoMap(detail.data, messageIDs)
  detail.data = next
}

function applyChildEvent(input: {
  detail: DetailState
  event: Event
  thinking: boolean
  limits: Record<string, number>
}) {
  const before = queueSnapshot(input.detail.data)
  const out = reduceSessionData({
    data: input.detail.data,
    event: input.event,
    sessionID: input.detail.sessionID,
    thinking: input.thinking,
    limits: input.limits,
  })
  const changed = appendCommits(input.detail, out.commits)
  compactDetail(input.detail)

  return changed || queueChanged(input.detail.data, before)
}

function bootstrapChildEvent(input: {
  detail: DetailState
  event: Event
  thinking: boolean
  limits: Record<string, number>
}) {
  const out = reduceSessionData({
    data: input.detail.data,
    event: input.event,
    sessionID: input.detail.sessionID,
    thinking: input.thinking,
    limits: input.limits,
  })

  return appendCommits(input.detail, out.commits)
}

function bootstrapChildMessages(input: {
  detail: DetailState
  messages: BootstrapChildMessage[]
  thinking: boolean
  limits: Record<string, number>
}) {
  let changed = false

  for (const message of input.messages) {
    changed =
      bootstrapChildEvent({
        detail: input.detail,
        event: {
          id: `bootstrap:message:${message.info.id}`,
          type: "message.updated",
          properties: {
            sessionID: input.detail.sessionID,
            info: message.info,
          },
        },
        thinking: input.thinking,
        limits: input.limits,
      }) || changed

    for (const part of message.parts) {
      changed =
        bootstrapChildEvent({
          detail: input.detail,
          event: {
            id: `bootstrap:part:${part.id}`,
            type: "message.part.updated",
            properties: {
              sessionID: input.detail.sessionID,
              part,
              time: 0,
            },
          },
          thinking: input.thinking,
          limits: input.limits,
        }) || changed
    }
  }

  compactDetail(input.detail)
  return changed
}

function knownSession(data: SubagentData, sessionID: string) {
  return data.tabs.has(sessionID)
}

export function listSubagentPermissions(data: SubagentData) {
  return [...data.details.values()].flatMap((detail) => detail.data.permissions)
}

export function listSubagentQuestions(data: SubagentData) {
  return [...data.details.values()].flatMap((detail) => detail.data.questions)
}

export function createSubagentData(): SubagentData {
  return {
    tabs: new Map(),
    details: new Map(),
    background: new Map(),
  }
}

function sameBackgroundInfo(a: BackgroundJobInfo | undefined, b: BackgroundJobInfo | undefined) {
  if (!a && !b) return true
  if (!a || !b) return false
  return (
    a.id === b.id &&
    a.type === b.type &&
    a.title === b.title &&
    a.status === b.status &&
    a.started_at === b.started_at &&
    a.completed_at === b.completed_at &&
    a.output === b.output &&
    a.error === b.error &&
    JSON.stringify(a.metadata) === JSON.stringify(b.metadata)
  )
}

function backgroundStatus(status: BackgroundJobInfo["status"]): FooterSubagentTab["status"] {
  if (status === "running") return "running"
  if (status === "completed") return "completed"
  if (status === "cancelled") return "cancelled"
  return "error"
}

function backgroundCommand(info: BackgroundJobInfo): string | undefined {
  const meta = info.metadata as Record<string, unknown> | undefined
  const cmd = meta ? (text(meta.command) ?? text(meta.cmd)) : undefined
  if (cmd) return cmd
  return info.title
}

export function backgroundToTab(info: BackgroundJobInfo): FooterSubagentTab {
  const command = backgroundCommand(info)
  const isShell = info.type === "shell"
  const label = isShell
    ? "Shell"
    : Locale.titlecase(
        text((info.metadata as any)?.subagent_type) ?? text((info.metadata as any)?.agent) ?? info.type ?? "general",
      )
  const description = isShell ? (command ?? info.title ?? info.id) : (info.title ?? (command as string) ?? info.id)
  const title = isShell
    ? (info.title && info.title !== command ? info.title : undefined) ?? (info.output ? info.output.slice(-200) : undefined)
    : (command && command !== info.title ? command : undefined) ?? info.title

  return {
    sessionID: info.id,
    partID: `background:${info.id}`,
    callID: `background:${info.id}`,
    label,
    description,
    status: backgroundStatus(info.status),
    background: true,
    title,
    lastUpdatedAt: info.completed_at ?? info.started_at ?? Date.now(),
  }
}

function syncBackgroundDetail(data: SubagentData, info: BackgroundJobInfo) {
  // Ensure detail exists for background job so inspector can show output
  const detail = ensureDetail(data, info.id)
  const output = info.output ?? info.error ?? ""
  const textContent = output || info.title || backgroundCommand(info) || info.id
  const commit: Extract<(typeof detail.frames)[number], { commit: any }>["commit"] | any = {
    kind: textContent ? "tool" : "system",
    text: textContent ? textContent.slice(-4000) : `Background job ${info.id} ${info.status}`,
    phase: info.status === "running" ? "progress" : "final",
    source: "tool",
    messageID: `background:${info.id}`,
    partID: `background:${info.id}:output`,
    tool: info.type === "shell" ? "bash" : "task",
  }
  // Replace frames with single synthetic frame reflecting latest output
  // Keep it simple - overwrite if output changed
  const key = `background:output:${info.id}`
  const existingIndex = detail.frames.findIndex((f) => f.key === key)
  if (existingIndex !== -1) {
    if (detail.frames[existingIndex].commit.text === commit.text && detail.frames[existingIndex].commit.phase === commit.phase) {
      return
    }
    detail.frames[existingIndex] = { key, commit }
  } else {
    detail.frames.push({ key, commit })
  }
  limitFrames(detail)
}

function snapshotDetail(detail: DetailState) {
  return {
    sessionID: detail.sessionID,
    commits: detail.frames.map((item) => item.commit),
  }
}

export function listSubagentTabs(data: SubagentData) {
  return [...data.tabs.values()].sort((a, b) => {
    const active = Number(b.status === "running") - Number(a.status === "running")
    if (active !== 0) {
      return active
    }

    return b.lastUpdatedAt - a.lastUpdatedAt
  })
}

export function listBackgroundJobs(data: SubagentData): BackgroundJobInfo[] {
  return [...data.background.values()].sort((a, b) => {
    const active = Number((b.status === "running" ? 1 : 0) - (a.status === "running" ? 1 : 0))
    if (active !== 0) return active
    return (b.started_at ?? 0) - (a.started_at ?? 0)
  })
}

export function listBackgroundTabs(data: SubagentData): FooterSubagentTab[] {
  return listBackgroundJobs(data).map(backgroundToTab)
}

export function listUnifiedTabs(data: SubagentData): FooterSubagentTab[] {
  const subagents = [...data.tabs.values()]
  const backgrounds = [...data.background.values()].map(backgroundToTab)
  const all = [...subagents, ...backgrounds]
  return all.sort((a, b) => {
    const active = Number(b.status === "running") - Number(a.status === "running")
    if (active !== 0) return active
    return b.lastUpdatedAt - a.lastUpdatedAt
  })
}

// Alias required by task spec
export const listAllTabsAndJobs = listUnifiedTabs
export const listAllTabs = listUnifiedTabs

export function getBackgroundJob(data: SubagentData, id: string): BackgroundJobInfo | undefined {
  return data.background.get(id)
}

export function setBackgroundJobs(input: { data: SubagentData; jobs: BackgroundJobInfo[] }): boolean {
  let changed = false
  const seen = new Set<string>()
  for (const job of input.jobs) {
    seen.add(job.id)
    const existing = input.data.background.get(job.id)
    if (!sameBackgroundInfo(existing, job)) {
      input.data.background.set(job.id, job)
      changed = true
    }
    syncBackgroundDetail(input.data, job)
  }
  // Remove jobs that no longer exist
  for (const id of [...input.data.background.keys()]) {
    if (!seen.has(id)) {
      input.data.background.delete(id)
      // Keep detail for history? Remove detail if it was purely background
      const detail = input.data.details.get(id)
      if (detail && detail.frames.every((f) => f.key.startsWith("background:"))) {
        input.data.details.delete(id)
      }
      changed = true
    }
  }
  return changed
}

export const bootstrapBackgroundJobs = setBackgroundJobs
export const setBackground = setBackgroundJobs

export function reduceBackgroundJobs(input: { data: SubagentData; jobs: BackgroundJobInfo[] }): boolean {
  return setBackgroundJobs(input)
}

function snapshotQueues(data: SubagentData) {
  return {
    permissions: listSubagentPermissions(data).sort((a, b) => a.id.localeCompare(b.id)),
    questions: listSubagentQuestions(data).sort((a, b) => a.id.localeCompare(b.id)),
  }
}

function snapshotState(data: SubagentData, details: FooterSubagentState["details"]): FooterSubagentState {
  return {
    tabs: listUnifiedTabs(data),
    details,
    ...snapshotQueues(data),
  }
}

// Keep old snapshot that only includes subagent tabs for compatibility if needed
export function snapshotSubagentDataWithoutBackground(data: SubagentData): FooterSubagentState {
  return {
    tabs: listSubagentTabs(data),
    details: Object.fromEntries([...data.details.entries()].map(([sessionID, detail]) => [sessionID, snapshotDetail(detail)])),
    ...snapshotQueues(data),
  }
}

export function snapshotSubagentData(data: SubagentData): FooterSubagentState {
  return snapshotState(
    data,
    Object.fromEntries([...data.details.entries()].map(([sessionID, detail]) => [sessionID, snapshotDetail(detail)])),
  )
}

export function snapshotSelectedSubagentData(
  data: SubagentData,
  selectedSessionID: string | undefined,
): FooterSubagentState {
  const detail = selectedSessionID ? data.details.get(selectedSessionID) : undefined

  return snapshotState(data, detail ? { [detail.sessionID]: snapshotDetail(detail) } : {})
}

export function bootstrapSubagentData(input: BootstrapSubagentInput) {
  const child = new Map(input.children.map((item) => [item.id, item]))
  const children = new Set(child.keys())
  let changed = false

  for (const message of input.messages) {
    for (const part of message.parts) {
      if (part.type !== "tool") {
        continue
      }

      changed = syncTaskTab(input.data, part, children) || changed
    }
  }

  for (const item of input.permissions) {
    if (!children.has(item.sessionID)) {
      continue
    }

    changed = ensureBlockerTab(input.data, item.sessionID, child.get(item.sessionID)?.title, "permission") || changed
  }

  for (const item of input.questions) {
    if (!children.has(item.sessionID)) {
      continue
    }

    changed = ensureBlockerTab(input.data, item.sessionID, child.get(item.sessionID)?.title, "question") || changed
  }

  for (const sessionID of input.data.tabs.keys()) {
    const detail = ensureDetail(input.data, sessionID)
    const before = queueSnapshot(detail.data)

    bootstrapSessionData({
      data: detail.data,
      messages: [],
      permissions: input.permissions
        .filter((item) => item.sessionID === sessionID)
        .sort((a, b) => a.id.localeCompare(b.id)),
      questions: input.questions
        .filter((item) => item.sessionID === sessionID)
        .sort((a, b) => a.id.localeCompare(b.id)),
    })
    compactDetail(detail)

    changed = queueChanged(detail.data, before) || changed
  }

  return changed
}

export function bootstrapSubagentCalls(input: {
  data: SubagentData
  sessionID: string
  messages: BootstrapChildMessage[]
  thinking: boolean
  limits: Record<string, number>
}) {
  if (!knownSession(input.data, input.sessionID) || input.messages.length === 0) {
    return false
  }

  const detail = ensureDetail(input.data, input.sessionID)
  const before = queueSnapshot(detail.data)
  const beforeCallCount = detail.data.call.size
  bootstrapSessionData({
    data: detail.data,
    messages: input.messages,
    permissions: detail.data.permissions,
    questions: detail.data.questions,
  })
  const changed = bootstrapChildMessages({
    detail,
    messages: input.messages,
    thinking: input.thinking,
    limits: input.limits,
  })

  return changed || beforeCallCount !== detail.data.call.size || queueChanged(detail.data, before)
}

export function reduceSubagentData(input: {
  data: SubagentData
  event: Event
  sessionID: string
  thinking: boolean
  limits: Record<string, number>
}) {
  const event = input.event

  if (event.type === "message.part.updated") {
    const part = event.properties.part
    if (part.sessionID === input.sessionID) {
      if (part.type !== "tool") {
        return false
      }

      return syncTaskTab(input.data, part)
    }
  }

  const sessionID =
    event.type === "message.updated" ||
    event.type === "message.part.delta" ||
    event.type === "permission.asked" ||
    event.type === "permission.replied" ||
    event.type === "question.asked" ||
    event.type === "question.replied" ||
    event.type === "question.rejected" ||
    event.type === "session.error" ||
    event.type === "session.status"
      ? event.properties.sessionID
      : event.type === "message.part.updated"
        ? event.properties.part.sessionID
        : undefined

  if (!sessionID || !knownSession(input.data, sessionID)) {
    return false
  }

  const detail = ensureDetail(input.data, sessionID)
  const cancelled =
    event.type === "message.updated" && isAbortedAssistantMessage(event.properties.info)
      ? cancelSubagentTab(input.data, sessionID)
      : false
  if (event.type === "session.status") {
    if (event.properties.status.type !== "retry") {
      return cancelled
    }

    return (
      appendCommits(detail, [
        {
          kind: "error",
          text: event.properties.status.message,
          phase: "start",
          source: "system",
          messageID: `retry:${event.properties.status.attempt}`,
        },
      ]) || cancelled
    )
  }

  if (event.type === "session.error" && event.properties.error) {
    return (
      appendCommits(detail, [
        {
          kind: "error",
          text: formatError(event.properties.error),
          phase: "start",
          source: "system",
          messageID: `session.error:${event.properties.sessionID}:${formatError(event.properties.error)}`,
        },
      ]) || cancelled
    )
  }

  return (
    applyChildEvent({
      detail,
      event,
      thinking: input.thinking,
      limits: input.limits,
    }) || cancelled
  )
}
