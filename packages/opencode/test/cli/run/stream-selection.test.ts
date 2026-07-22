import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { OpencodeClient, type GlobalEvent } from "@opencode-ai/sdk/v2"
import { createSessionTransport } from "@/cli/cmd/run/stream.transport"
import type { FooterApi, FooterEvent, StreamCommit } from "@/cli/cmd/run/types"

type EventStream = Awaited<ReturnType<OpencodeClient["event"]["subscribe"]>>["stream"]
type GlobalEventStream = Awaited<ReturnType<OpencodeClient["global"]["event"]>>["stream"]
type SdkEvent = EventStream extends AsyncGenerator<infer T, unknown, unknown> ? T : never
type SessionMessage = NonNullable<Awaited<ReturnType<OpencodeClient["session"]["messages"]>>["data"]>[number]
type SessionChild = NonNullable<Awaited<ReturnType<OpencodeClient["session"]["children"]>>["data"]>[number]
type SessionToolPart = Extract<SessionMessage["parts"][number], { type: "tool" }>
type TextPart = Extract<SessionMessage["parts"][number], { type: "text" }>

afterEach(() => {
  mock.restore()
})

async function waitFor<T>(check: () => T | undefined, timeout = 2_000): Promise<T> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = check()
    if (value !== undefined) return value
    await Bun.sleep(10)
  }
  throw new Error("timed out waiting for value")
}

function busy(sessionID = "session-1") {
  return {
    id: `evt-${sessionID}-busy`,
    type: "session.status",
    properties: { sessionID, status: { type: "busy" } },
  } satisfies SdkEvent
}

function idle(sessionID = "session-1") {
  return {
    id: `evt-${sessionID}-idle`,
    type: "session.status",
    properties: { sessionID, status: { type: "idle" } },
  } satisfies SdkEvent
}

const StreamClosed = undefined as never

function feed<T, R = never>(returnValue: R = StreamClosed) {
  const list: T[] = []
  let done = false
  let wake: (() => void) | undefined
  const wrapped = (async function* (): AsyncGenerator<T, R, unknown> {
    while (!done || list.length > 0) {
      if (list.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve
        })
        continue
      }
      const next = list.shift()
      if (!next) continue
      yield next
    }
    return returnValue as R
  })()
  return {
    stream: wrapped,
    push(value: T) {
      list.push(value)
      wake?.()
      wake = undefined
    },
    close() {
      done = true
      wake?.()
      wake = undefined
    },
  }
}

function eventFeed() {
  return feed<SdkEvent>()
}

function globalFeed() {
  return feed<GlobalEvent>()
}

function emptyStream(): EventStream {
  return (async function* (): AsyncGenerator<SdkEvent> {})()
}

function ok<T>(data: T) {
  return Promise.resolve({
    data,
    error: undefined,
    request: new Request("https://opencode.test"),
    response: new Response(),
  })
}

function sse(stream: EventStream) {
  return Promise.resolve({ stream })
}

function globalSse(stream: GlobalEventStream) {
  return Promise.resolve({ stream })
}

function wrapGlobalStream(stream: EventStream): GlobalEventStream {
  return (async function* (): GlobalEventStream {
    for await (const event of stream) {
      yield globalEvent(event)
    }
    return StreamClosed
  })()
}

function assistantMessage(input: { sessionID: string; id: string; parts: SessionMessage["parts"] }): SessionMessage {
  return {
    info: {
      id: input.id,
      sessionID: input.sessionID,
      role: "assistant",
      time: { created: 1 },
      parentID: "msg-user-1",
      modelID: "gpt-5",
      providerID: "openai",
      mode: "chat",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: {
        input: 1,
        output: 1,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
    parts: input.parts,
  }
}

function runningTool(input: {
  sessionID: string
  messageID: string
  id: string
  callID: string
  tool: string
  body: Record<string, unknown>
  metadata?: Record<string, unknown>
}): SessionToolPart {
  return {
    id: input.id,
    sessionID: input.sessionID,
    messageID: input.messageID,
    type: "tool",
    callID: input.callID,
    tool: input.tool,
    state: {
      status: "running",
      input: input.body,
      ...(input.metadata ? { metadata: input.metadata } : {}),
      time: { start: 1 },
    },
  }
}

function textPart(id: string, messageID: string, text: string, sessionID = "session-1"): TextPart {
  return { id, sessionID, messageID, type: "text", text }
}

function textUpdated(part: TextPart): SdkEvent {
  return {
    id: `evt-${part.id}-updated`,
    type: "message.part.updated",
    properties: { sessionID: part.sessionID, part, time: 1 },
  }
}

function toolUpdated(part: SessionToolPart): SdkEvent {
  return {
    id: `evt-${part.id}-updated`,
    type: "message.part.updated",
    properties: { sessionID: part.sessionID, part, time: 1 },
  }
}

function textDelta(messageID: string, partID: string, delta: string, sessionID = "session-1"): SdkEvent {
  return {
    id: `evt-${partID}-delta`,
    type: "message.part.delta",
    properties: { sessionID, messageID, partID, field: "text", delta },
  }
}

function child(id: string): SessionChild {
  return {
    id,
    slug: id,
    projectID: "project-1",
    directory: "/tmp",
    title: id,
    version: "1",
    time: { created: 1, updated: 1 },
  }
}

function globalEvent(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory: "/tmp", project: "project-1", payload }
}

function footerFn(onCommit?: (commit: StreamCommit) => void) {
  const commits: StreamCommit[] = []
  const events: FooterEvent[] = []
  let closed = false
  let idleCalls = 0
  const api: FooterApi = {
    get isClosed() {
      return closed
    },
    onPrompt: () => () => {},
    onQueuedRemove: () => () => {},
    onClose: () => () => {},
    event(next) {
      events.push(next)
    },
    append(next) {
      commits.push(next)
      onCommit?.(next)
    },
    idle() {
      idleCalls += 1
      return Promise.resolve()
    },
    close() {
      closed = true
    },
    destroy() {
      closed = true
    },
  }
  return { api, commits, events, get idleCalls() { return idleCalls } }
}

function sdkClient(input: {
  stream?: EventStream
  globalStream?: GlobalEventStream
  subscribe?: OpencodeClient["event"]["subscribe"]
  globalEvent?: OpencodeClient["global"]["event"]
  promptAsync?: OpencodeClient["session"]["promptAsync"]
  shell?: OpencodeClient["session"]["shell"]
  command?: OpencodeClient["session"]["command"]
  status?: OpencodeClient["session"]["status"]
  messages?: OpencodeClient["session"]["messages"]
  children?: OpencodeClient["session"]["children"]
  permissions?: OpencodeClient["permission"]["list"]
  questions?: OpencodeClient["question"]["list"]
  appAgents?: OpencodeClient["app"]["agents"]
} = {}) {
  const client = new OpencodeClient()
  const subscribe: OpencodeClient["event"]["subscribe"] = input.subscribe ?? (() => sse(input.stream ?? emptyStream()))
  const globalEvt: OpencodeClient["global"]["event"] =
    input.globalEvent ?? (() => globalSse(input.globalStream ?? wrapGlobalStream(input.stream ?? emptyStream())))
  const promptAsync: OpencodeClient["session"]["promptAsync"] = input.promptAsync ?? (() => ok(undefined))
  const shell: OpencodeClient["session"]["shell"] = (input.shell as any) ?? (() => ok(undefined))
  const command: OpencodeClient["session"]["command"] = (input.command as any) ?? (() => ok(undefined))
  const status: OpencodeClient["session"]["status"] = input.status ?? (() => ok({}))
  const messages: OpencodeClient["session"]["messages"] = input.messages ?? (() => ok([]))
  const children: OpencodeClient["session"]["children"] = input.children ?? (() => ok([]))
  const permissions: OpencodeClient["permission"]["list"] = input.permissions ?? (() => ok([]))
  const questions: OpencodeClient["question"]["list"] = input.questions ?? (() => ok([]))
  const appAgents: OpencodeClient["app"]["agents"] = (input.appAgents as any) ?? (() => ok([]))

  spyOn(client.event, "subscribe").mockImplementation(subscribe)
  spyOn(client.global, "event").mockImplementation(globalEvt)
  spyOn(client.session, "promptAsync").mockImplementation(promptAsync)
  spyOn(client.session, "shell").mockImplementation(shell)
  spyOn(client.session, "command").mockImplementation(command)
  spyOn(client.session, "status").mockImplementation(status)
  spyOn(client.session, "messages").mockImplementation(messages)
  spyOn(client.session, "children").mockImplementation(children)
  spyOn(client.permission, "list").mockImplementation(permissions)
  spyOn(client.question, "list").mockImplementation(questions)
  spyOn(client.app, "agents").mockImplementation(appAgents as any)

  return client
}

describe("stream transport selectedSubagent targeting", () => {
  test("runPromptTurn targets main when no subagent selected", async () => {
    const src = eventFeed()
    const ui = footerFn()
    const promptCalls: any[] = []
    const transport = await createSessionTransport({
      sdk: sdkClient({
        stream: src.stream,
        promptAsync: async (req: any) => {
          promptCalls.push(req)
          queueMicrotask(() => {
            src.push(busy("session-1"))
            src.push(idle("session-1"))
          })
          return ok(undefined)
        },
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await transport.runPromptTurn({
        agent: undefined,
        model: undefined,
        variant: undefined,
        prompt: { text: "hello main", parts: [] } as any,
        files: [],
        includeFiles: false,
      })

      expect(promptCalls.length).toBe(1)
      expect(promptCalls[0].sessionID).toBe("session-1")
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("runPromptTurn targets selectedSubagent when set", async () => {
    const global = globalFeed()
    const ui = footerFn()
    const promptCalls: any[] = []
    let statusBusy = true

    const transport = await createSessionTransport({
      sdk: sdkClient({
        globalStream: global.stream,
        messages: async ({ sessionID }: any) => {
          if (sessionID === "session-1") {
            return ok([
              assistantMessage({
                sessionID: "session-1",
                id: "msg-1",
                parts: [
                  runningTool({
                    sessionID: "session-1",
                    messageID: "msg-1",
                    id: "task-1",
                    callID: "call-1",
                    tool: "task",
                    body: { description: "Explore", subagent_type: "explore" },
                    metadata: { sessionId: "child-1" },
                  }),
                ],
              }),
            ])
          }
          return ok([])
        },
        children: async () => ok([child("child-1")]),
        promptAsync: async (req: any) => {
          promptCalls.push(req)
          // Simulate busy -> idle for child
          queueMicrotask(() => {
            global.push(globalEvent(busy("child-1")))
          })
          setTimeout(() => {
            statusBusy = false
            global.push(globalEvent(idle("child-1")))
          }, 20)
          return ok(undefined)
        },
        status: async () => {
          if (statusBusy) {
            return ok({ "child-1": { type: "busy" }, "session-1": { type: "idle" } })
          }
          return ok({ "child-1": { type: "idle" }, "session-1": { type: "idle" } })
        },
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      // wait for child tab to bootstrap
      await waitFor(() => {
        const item = ui.events.findLast((e) => e.type === "stream.subagent")
        return item?.type === "stream.subagent" && item.state.tabs.some((t: any) => t.sessionID === "child-1")
          ? item
          : undefined
      })

      transport.selectSubagent("child-1")

      // verify footer reflects selected
      await waitFor(() => {
        const item = ui.events.findLast((e) => e.type === "stream.subagent")
        if (!item || item.type !== "stream.subagent") return undefined
        // selected data should contain details key? Actually snapshotSelected includes only selected detail if we select after bootstrap history, but tabs present
        return item.state.tabs.find((t: any) => t.sessionID === "child-1") ? item : undefined
      })

      await transport.runPromptTurn({
        agent: undefined,
        model: undefined,
        variant: undefined,
        prompt: { text: "steer subagent", parts: [] } as any,
        files: [],
        includeFiles: false,
      })

      expect(promptCalls.length).toBe(1)
      expect(promptCalls[0].sessionID).toBe("child-1")
      expect(promptCalls[0].parts.some((p: any) => p.text === "steer subagent")).toBe(true)
    } finally {
      global.close()
      await transport.close()
    }
  })

  test("keeps selectedSubagent after turn completes so user can continue chatting", async () => {
    const global = globalFeed()
    const ui = footerFn()
    const promptCalls: any[] = []
    let statusBusy = true

    const transport = await createSessionTransport({
      sdk: sdkClient({
        globalStream: global.stream,
        messages: async ({ sessionID }: any) => {
          if (sessionID === "session-1") {
            return ok([
              assistantMessage({
                sessionID: "session-1",
                id: "msg-1",
                parts: [
                  runningTool({
                    sessionID: "session-1",
                    messageID: "msg-1",
                    id: "task-1",
                    callID: "call-1",
                    tool: "task",
                    body: { description: "Explore", subagent_type: "explore" },
                    metadata: { sessionId: "child-1" },
                  }),
                ],
              }),
            ])
          }
          return ok([])
        },
        children: async () => ok([child("child-1")]),
        promptAsync: async (req: any) => {
          promptCalls.push(req)
          queueMicrotask(() => global.push(globalEvent(busy("child-1"))))
          setTimeout(() => {
            statusBusy = false
            global.push(globalEvent(idle("child-1")))
          }, 20)
          return ok(undefined)
        },
        status: async () => {
          if (statusBusy) return ok({ "child-1": { type: "busy" } })
          return ok({ "child-1": { type: "idle" } })
        },
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await waitFor(() => {
        const item = ui.events.findLast((e) => e.type === "stream.subagent")
        return item?.type === "stream.subagent" && item.state.tabs.some((t: any) => t.sessionID === "child-1")
          ? item
          : undefined
      })

      transport.selectSubagent("child-1")

      await transport.runPromptTurn({
        agent: undefined,
        model: undefined,
        variant: undefined,
        prompt: { text: "first steer", parts: [] } as any,
        files: [],
        includeFiles: false,
      })

      expect(promptCalls[0].sessionID).toBe("child-1")

      // second turn should still target child because selection kept
      statusBusy = true
      await transport.runPromptTurn({
        agent: undefined,
        model: undefined,
        variant: undefined,
        prompt: { text: "second steer", parts: [] } as any,
        files: [],
        includeFiles: false,
      })

      expect(promptCalls.length).toBe(2)
      expect(promptCalls[1].sessionID).toBe("child-1")
      expect(promptCalls[1].parts.some((p: any) => p.text === "second steer")).toBe(true)
    } finally {
      global.close()
      await transport.close()
    }
  })

  test("idle for main does NOT complete subagent-targeted turn, only subagent idle does", async () => {
    const global = globalFeed()
    const ui = footerFn()
    const promptCalls: any[] = []
    let statusBusy = true

    const transport = await createSessionTransport({
      sdk: sdkClient({
        globalStream: global.stream,
        messages: async ({ sessionID }: any) => {
          if (sessionID === "session-1") {
            return ok([
              assistantMessage({
                sessionID: "session-1",
                id: "msg-1",
                parts: [
                  runningTool({
                    sessionID: "session-1",
                    messageID: "msg-1",
                    id: "task-1",
                    callID: "call-1",
                    tool: "task",
                    body: { description: "Explore", subagent_type: "explore" },
                    metadata: { sessionId: "child-1" },
                  }),
                ],
              }),
            ])
          }
          return ok([])
        },
        children: async () => ok([child("child-1")]),
        promptAsync: async (req: any) => {
          promptCalls.push(req)
          queueMicrotask(() => global.push(globalEvent(busy("child-1"))))
          // push main idle early - should NOT resolve
          setTimeout(() => global.push(globalEvent(idle("session-1"))), 10)
          setTimeout(() => {
            statusBusy = false
            global.push(globalEvent(idle("child-1")))
          }, 50)
          return ok(undefined)
        },
        status: async () => {
          if (statusBusy) return ok({ "child-1": { type: "busy" }, "session-1": { type: "idle" } })
          return ok({ "child-1": { type: "idle" }, "session-1": { type: "idle" } })
        },
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await waitFor(() => {
        const item = ui.events.findLast((e) => e.type === "stream.subagent")
        return item?.type === "stream.subagent" && item.state.tabs.some((t: any) => t.sessionID === "child-1")
          ? item
          : undefined
      })

      transport.selectSubagent("child-1")

      let completed = false
      const turnPromise = transport
        .runPromptTurn({
          agent: undefined,
          model: undefined,
          variant: undefined,
          prompt: { text: "wait for child idle", parts: [] } as any,
          files: [],
          includeFiles: false,
        })
        .then(() => {
          completed = true
        })

      // after main idle pushed, should still not be completed
      await Bun.sleep(30)
      expect(completed).toBe(false)

      await turnPromise
      expect(completed).toBe(true)
      expect(promptCalls[0].sessionID).toBe("child-1")
    } finally {
      global.close()
      await transport.close()
    }
  })

  test("onVisibleOutput fires for selected subagent commits", async () => {
    const global = globalFeed()
    const ui = footerFn()
    const visibleOutputs: any[] = []
    let statusBusy = true

    const transport = await createSessionTransport({
      sdk: sdkClient({
        globalStream: global.stream,
        messages: async ({ sessionID }: any) => {
          if (sessionID === "session-1") {
            return ok([
              assistantMessage({
                sessionID: "session-1",
                id: "msg-1",
                parts: [
                  runningTool({
                    sessionID: "session-1",
                    messageID: "msg-1",
                    id: "task-1",
                    callID: "call-1",
                    tool: "task",
                    body: { description: "Explore", subagent_type: "explore" },
                    metadata: { sessionId: "child-1" },
                  }),
                ],
              }),
            ])
          }
          // child history empty
          return ok([])
        },
        children: async () => ok([child("child-1")]),
        promptAsync: async (req: any) => {
          queueMicrotask(() => {
            global.push(globalEvent(busy("child-1")))
            // push child assistant message
            global.push(
              globalEvent({
                id: "evt-child-msg",
                type: "message.updated",
                properties: {
                  sessionID: "child-1",
                  info: assistantMessage({
                    sessionID: "child-1",
                    id: "msg-child-1",
                    parts: [],
                  }).info,
                },
              }),
            )
            global.push(globalEvent(textUpdated(textPart("txt-child-1", "msg-child-1", "hello subagent", "child-1"))))
          })
          setTimeout(() => {
            statusBusy = false
            global.push(globalEvent(idle("child-1")))
          }, 30)
          return ok(undefined)
        },
        status: async () => {
          if (statusBusy) return ok({ "child-1": { type: "busy" } })
          return ok({ "child-1": { type: "idle" } })
        },
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await waitFor(() => {
        const item = ui.events.findLast((e) => e.type === "stream.subagent")
        return item?.type === "stream.subagent" && item.state.tabs.some((t: any) => t.sessionID === "child-1")
          ? item
          : undefined
      })

      transport.selectSubagent("child-1")

      await transport.runPromptTurn({
        agent: undefined,
        model: undefined,
        variant: undefined,
        prompt: { text: "steer", parts: [] } as any,
        files: [],
        includeFiles: false,
        onVisibleOutput: (anchor: any) => {
          visibleOutputs.push(anchor)
        },
      })

      // onVisibleOutput should have been called at least once for subagent output
      expect(visibleOutputs.length).toBeGreaterThan(0)
      // find one containing our hello
      const hasHello = visibleOutputs.some((o) => typeof o.text === "string" && o.text.includes("hello"))
      expect(hasHello).toBe(true)
    } finally {
      global.close()
      await transport.close()
    }
  })

  test("selectSubagent(undefined) returns targeting to main", async () => {
    const global = globalFeed()
    const ui = footerFn()
    const promptCalls: any[] = []
    let childBusy = true
    let mainBusy = false

    const transport = await createSessionTransport({
      sdk: sdkClient({
        globalStream: global.stream,
        messages: async ({ sessionID }: any) => {
          if (sessionID === "session-1") {
            return ok([
              assistantMessage({
                sessionID: "session-1",
                id: "msg-1",
                parts: [
                  runningTool({
                    sessionID: "session-1",
                    messageID: "msg-1",
                    id: "task-1",
                    callID: "call-1",
                    tool: "task",
                    body: { description: "Explore", subagent_type: "explore" },
                    metadata: { sessionId: "child-1" },
                  }),
                ],
              }),
            ])
          }
          return ok([])
        },
        children: async () => ok([child("child-1")]),
        promptAsync: async (req: any) => {
          promptCalls.push(req)
          const target = req.sessionID
          queueMicrotask(() => global.push(globalEvent(busy(target))))
          setTimeout(() => {
            if (target === "child-1") childBusy = false
            if (target === "session-1") mainBusy = false
            global.push(globalEvent(idle(target)))
          }, 20)
          return ok(undefined)
        },
        status: async () => {
          const map: any = {}
          if (childBusy) map["child-1"] = { type: "busy" }
          else map["child-1"] = { type: "idle" }
          if (mainBusy) map["session-1"] = { type: "busy" }
          else map["session-1"] = { type: "idle" }
          return ok(map)
        },
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await waitFor(() => {
        const item = ui.events.findLast((e) => e.type === "stream.subagent")
        return item?.type === "stream.subagent" && item.state.tabs.some((t: any) => t.sessionID === "child-1")
          ? item
          : undefined
      })

      transport.selectSubagent("child-1")
      childBusy = true
      await transport.runPromptTurn({
        agent: undefined,
        model: undefined,
        variant: undefined,
        prompt: { text: "to child", parts: [] } as any,
        files: [],
        includeFiles: false,
      })
      expect(promptCalls[0].sessionID).toBe("child-1")

      // now deselect
      transport.selectSubagent(undefined)
      mainBusy = true
      await transport.runPromptTurn({
        agent: undefined,
        model: undefined,
        variant: undefined,
        prompt: { text: "back to main", parts: [] } as any,
        files: [],
        includeFiles: false,
      })
      expect(promptCalls[1].sessionID).toBe("session-1")
    } finally {
      global.close()
      await transport.close()
    }
  })
})
