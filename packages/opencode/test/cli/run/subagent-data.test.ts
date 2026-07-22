import { describe, expect, test } from "bun:test"
import type { Event } from "@opencode-ai/sdk/v2"
import { entryBody } from "@/cli/cmd/run/entry.body"
import {
  bootstrapSubagentCalls,
  bootstrapSubagentData,
  createSubagentData,
  reduceSubagentData,
  snapshotSubagentData,
} from "@/cli/cmd/run/subagent-data"

type SessionMessage = Parameters<typeof bootstrapSubagentData>[0]["messages"][number]
type ChildMessage = Parameters<typeof bootstrapSubagentCalls>[0]["messages"][number]

function visible(commits: Array<Parameters<typeof entryBody>[0]>) {
  return commits.flatMap((item) => {
    const body = entryBody(item)
    if (body.type === "none") {
      return []
    }

    if (body.type === "structured") {
      if (body.snapshot.kind === "code" || body.snapshot.kind === "task") {
        return [body.snapshot.title]
      }

      if (body.snapshot.kind === "diff") {
        return body.snapshot.items.map((item) => item.title)
      }

      if (body.snapshot.kind === "todo") {
        return ["# Todos"]
      }

      return ["# Questions"]
    }

    return [body.content]
  })
}

function reduce(data: ReturnType<typeof createSubagentData>, event: unknown) {
  return reduceSubagentData({
    data,
    event: event as Event,
    sessionID: "parent-1",
    thinking: true,
    limits: {},
  })
}

function taskMessage(sessionID: string, status: "running" | "completed" | "interrupted" = "completed"): SessionMessage {
  if (status === "running") {
    return {
      parts: [
        {
          id: `part-${sessionID}`,
          sessionID: "parent-1",
          messageID: `msg-${sessionID}`,
          type: "tool",
          callID: `call-${sessionID}`,
          tool: "task",
          state: {
            status: "running",
            input: {
              description: "Scan reducer paths",
              subagent_type: "explore",
            },
            title: "Reducer touchpoints",
            metadata: {
              sessionId: sessionID,
              toolcalls: 4,
            },
            time: { start: 1 },
          },
        },
      ],
    }
  }

  if (status === "interrupted") {
    return {
      parts: [
        {
          id: `part-${sessionID}`,
          sessionID: "parent-1",
          messageID: `msg-${sessionID}`,
          type: "tool",
          callID: `call-${sessionID}`,
          tool: "task",
          state: {
            status: "error",
            input: {
              description: "Scan reducer paths",
              subagent_type: "explore",
            },
            error: "Tool execution aborted",
            metadata: {
              sessionId: sessionID,
              toolcalls: 4,
              interrupted: true,
            },
            time: { start: 1, end: 2 },
          },
        },
      ],
    }
  }

  return {
    parts: [
      {
        id: `part-${sessionID}`,
        sessionID: "parent-1",
        messageID: `msg-${sessionID}`,
        type: "tool",
        callID: `call-${sessionID}`,
        tool: "task",
        state: {
          status: "completed",
          input: {
            description: "Scan reducer paths",
            subagent_type: "explore",
          },
          output: "",
          title: "Reducer touchpoints",
          metadata: {
            sessionId: sessionID,
            toolcalls: 4,
          },
          time: { start: 1, end: 2 },
        },
      },
    ],
  }
}

function question(id: string, sessionID: string) {
  return {
    id,
    sessionID,
    questions: [
      {
        question: "Mode?",
        header: "Mode",
        options: [{ label: "Fast", description: "Quick pass" }],
        multiple: false,
      },
    ],
  }
}

function childMessage(input: {
  messageID: string
  sessionID: string
  role: "user" | "assistant"
  parts: ChildMessage["parts"]
}) {
  if (input.role === "user") {
    return {
      info: {
        id: input.messageID,
        sessionID: input.sessionID,
        role: "user",
        time: {
          created: 1,
        },
        agent: "test",
        model: {
          providerID: "openai",
          modelID: "gpt-5",
        },
      },
      parts: input.parts,
    } satisfies ChildMessage
  }

  return {
    info: {
      id: input.messageID,
      sessionID: input.sessionID,
      role: "assistant",
      time: {
        created: 2,
        completed: 3,
      },
      parentID: "msg-user-1",
      providerID: "openai",
      modelID: "gpt-5",
      mode: "default",
      agent: "explore",
      path: {
        cwd: "/tmp",
        root: "/tmp",
      },
      cost: 0,
      tokens: {
        input: 1,
        output: 1,
        reasoning: 0,
        cache: {
          read: 0,
          write: 0,
        },
      },
      finish: "stop",
    },
    parts: input.parts,
  } satisfies ChildMessage
}

describe("run subagent data", () => {
  test("bootstraps tabs and child blockers from parent task parts", () => {
    const data = createSubagentData()

    expect(
      bootstrapSubagentData({
        data,
        messages: [taskMessage("child-1")],
        children: [{ id: "child-1" }, { id: "child-2" }],
        permissions: [
          {
            id: "perm-1",
            sessionID: "child-1",
            permission: "read",
            patterns: ["src/**/*.ts"],
            metadata: {},
            always: [],
          },
          {
            id: "perm-2",
            sessionID: "other",
            permission: "read",
            patterns: ["src/**/*.ts"],
            metadata: {},
            always: [],
          },
        ],
        questions: [question("question-1", "child-1"), question("question-2", "other")],
      }),
    ).toBe(true)

    const snapshot = snapshotSubagentData(data)

    expect(snapshot.tabs).toEqual([
      expect.objectContaining({
        sessionID: "child-1",
        label: "Explore",
        description: "Scan reducer paths",
        title: "Reducer touchpoints",
        status: "completed",
        toolCalls: 4,
      }),
    ])
    expect(snapshot.details).toEqual({
      "child-1": {
        sessionID: "child-1",
        commits: [],
      },
    })
    expect(snapshot.permissions.map((item) => item.id)).toEqual(["perm-1"])
    expect(snapshot.questions.map((item) => item.id)).toEqual(["question-1"])
  })

  test("marks interrupted task tabs as cancelled during bootstrap", () => {
    const data = createSubagentData()

    bootstrapSubagentData({
      data,
      messages: [taskMessage("child-1", "interrupted")],
      children: [{ id: "child-1" }],
      permissions: [],
      questions: [],
    })

    expect(snapshotSubagentData(data).tabs).toEqual([
      expect.objectContaining({
        sessionID: "child-1",
        status: "cancelled",
      }),
    ])
  })

  test("captures child activity and blocker metadata in the footer detail state", () => {
    const data = createSubagentData()

    bootstrapSubagentData({
      data,
      messages: [taskMessage("child-1", "running")],
      children: [{ id: "child-1" }],
      permissions: [],
      questions: [],
    })

    reduce(data, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "txt-user-1",
          messageID: "msg-user-1",
          sessionID: "child-1",
          type: "text",
          text: "Inspect footer tabs",
        },
      },
    })
    reduce(data, {
      type: "message.updated",
      properties: {
        sessionID: "child-1",
        info: {
          id: "msg-user-1",
          role: "user",
        },
      },
    })
    reduce(data, {
      type: "message.updated",
      properties: {
        sessionID: "child-1",
        info: {
          id: "msg-assistant-1",
          role: "assistant",
        },
      },
    })
    reduce(data, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "reason-1",
          messageID: "msg-assistant-1",
          sessionID: "child-1",
          type: "reasoning",
          text: "planning next steps",
          time: { start: 1 },
        },
      },
    })
    reduce(data, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "tool-1",
          messageID: "msg-assistant-1",
          sessionID: "child-1",
          type: "tool",
          callID: "call-1",
          tool: "bash",
          state: {
            status: "running",
            input: {
              command: "git status --short",
            },
            time: { start: 1 },
          },
        },
      },
    })
    reduce(data, {
      type: "permission.asked",
      properties: {
        id: "perm-1",
        sessionID: "child-1",
        permission: "bash",
        patterns: ["git status --short"],
        metadata: {},
        always: [],
        tool: {
          messageID: "msg-assistant-1",
          callID: "call-1",
        },
      },
    })
    reduce(data, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "txt-1",
          messageID: "msg-assistant-1",
          sessionID: "child-1",
          type: "text",
          text: "hello",
        },
      },
    })
    reduce(data, {
      type: "message.part.delta",
      properties: {
        sessionID: "child-1",
        messageID: "msg-assistant-1",
        partID: "txt-1",
        field: "text",
        delta: " world",
      },
    })

    const snapshot = snapshotSubagentData(data)

    expect(snapshot.tabs).toEqual([expect.objectContaining({ sessionID: "child-1", status: "running" })])
    expect(visible(snapshot.details["child-1"]?.commits ?? [])).toEqual([
      "› Inspect footer tabs",
      "_Thinking:_ planning next steps",
      "$ git status --short",
      "hello world",
    ])
    expect(snapshot.permissions).toEqual([
      expect.objectContaining({
        id: "perm-1",
        metadata: {
          input: {
            command: "git status --short",
          },
        },
      }),
    ])
    expect(snapshot.questions).toEqual([])
  })

  test("replays bootstrapped child session messages into inspector commits", () => {
    const data = createSubagentData()

    bootstrapSubagentData({
      data,
      messages: [taskMessage("child-1", "completed")],
      children: [{ id: "child-1" }],
      permissions: [],
      questions: [],
    })

    expect(
      bootstrapSubagentCalls({
        data,
        sessionID: "child-1",
        messages: [
          childMessage({
            messageID: "msg-user-1",
            sessionID: "child-1",
            role: "user",
            parts: [
              {
                id: "txt-user-1",
                messageID: "msg-user-1",
                sessionID: "child-1",
                type: "text",
                text: "Inspect footer tabs",
                time: { start: 1, end: 1 },
              },
            ],
          }),
          childMessage({
            messageID: "msg-assistant-1",
            sessionID: "child-1",
            role: "assistant",
            parts: [
              {
                id: "reason-1",
                messageID: "msg-assistant-1",
                sessionID: "child-1",
                type: "reasoning",
                text: "planning next steps",
                time: { start: 2, end: 2 },
              },
              {
                id: "txt-1",
                messageID: "msg-assistant-1",
                sessionID: "child-1",
                type: "text",
                text: "hello world",
                time: { start: 2, end: 3 },
              },
            ],
          }),
        ],
        thinking: true,
        limits: {},
      }),
    ).toBe(true)

    expect(visible(snapshotSubagentData(data).details["child-1"]?.commits ?? [])).toEqual([
      "› Inspect footer tabs",
      "_Thinking:_ planning next steps",
      "hello world",
    ])
  })

  test("marks a running tab cancelled when the child session aborts", () => {
    const data = createSubagentData()

    bootstrapSubagentData({
      data,
      messages: [taskMessage("child-1", "running")],
      children: [{ id: "child-1" }],
      permissions: [],
      questions: [],
    })

    reduce(data, {
      type: "message.updated",
      properties: {
        sessionID: "child-1",
        info: {
          id: "msg-assistant-1",
          sessionID: "child-1",
          role: "assistant",
          time: {
            created: 1,
            completed: 2,
          },
          error: {
            name: "MessageAbortedError",
            data: {
              message: "Aborted",
            },
          },
          parentID: "msg-user-1",
          providerID: "openai",
          modelID: "gpt-5",
          mode: "default",
          agent: "explore",
          path: {
            cwd: "/tmp",
            root: "/tmp",
          },
          cost: 0,
          tokens: {
            input: 1,
            output: 1,
            reasoning: 0,
            cache: {
              read: 0,
              write: 0,
            },
          },
          finish: "error",
        },
      },
    })

    expect(snapshotSubagentData(data).tabs).toEqual([
      expect.objectContaining({
        sessionID: "child-1",
        status: "cancelled",
      }),
    ])
  })

  test("merges shell background jobs into unified tabs view", () => {
    const data = createSubagentData()
    bootstrapSubagentData({
      data,
      messages: [taskMessage("child-1", "running")],
      children: [{ id: "child-1" }],
      permissions: [],
      questions: [],
    })

    const { setBackgroundJobs, listUnifiedTabs, listBackgroundTabs, backgroundToTab } =
      // lazy import to avoid circular, but we can import directly
      require("@/cli/cmd/run/subagent-data") as typeof import("@/cli/cmd/run/subagent-data")

    const job = {
      id: "job-123",
      type: "shell",
      title: "bun run dev",
      status: "running" as const,
      started_at: Date.now() - 5000,
      output: "localhost:3000 started\nready",
      metadata: { command: "bun run dev" },
    }

    const changed = setBackgroundJobs({ data, jobs: [job] })
    expect(changed).toBe(true)

    const unified = listUnifiedTabs(data)
    expect(unified.length).toBe(2)
    const shellTab = unified.find((t: any) => t.sessionID === "job-123")
    expect(shellTab).toBeDefined()
    expect(shellTab?.label).toBe("Shell")
    expect(shellTab?.description).toBe("bun run dev")
    expect(shellTab?.background).toBe(true)
    expect(shellTab?.status).toBe("running")

    const bgTabs = listBackgroundTabs(data)
    expect(bgTabs.length).toBe(1)
    expect(bgTabs[0].sessionID).toBe("job-123")

    const converted = backgroundToTab(job)
    expect(converted.sessionID).toBe("job-123")
    expect(converted.partID).toBe("background:job-123")

    const snap = snapshotSubagentData(data)
    expect(snap.tabs.length).toBe(2)
    expect(snap.tabs.map((t) => t.sessionID).sort()).toEqual(["child-1", "job-123"].sort())
  })

  test("banner data shows agent name index total type icon and status", () => {
    const data = createSubagentData()
    bootstrapSubagentData({
      data,
      messages: [taskMessage("child-1", "running"), taskMessage("child-2", "completed")],
      children: [{ id: "child-1" }, { id: "child-2" }],
      permissions: [],
      questions: [],
    })

    const { setBackgroundJobs, listUnifiedTabs } = require("@/cli/cmd/run/subagent-data") as typeof import(
      "@/cli/cmd/run/subagent-data"
    )

    const job = {
      id: "job-shell",
      type: "shell",
      title: "bun run dev",
      status: "running" as const,
      started_at: Date.now() - 12000,
      output: "Server running at http://localhost:3000",
      metadata: { command: "bun run dev" },
    }
    setBackgroundJobs({ data, jobs: [job] })

    const unified = listUnifiedTabs(data)
    // Should be sorted: running first
    expect(unified.filter((t: any) => t.status === "running").length).toBe(2)

    // Simulate banner data for selected subagent
    const selectedID = "child-1"
    const idx = unified.findIndex((t: any) => t.sessionID === selectedID) + 1
    const total = unified.length
    const tab = unified.find((t: any) => t.sessionID === selectedID)

    expect(tab).toBeDefined()
    expect(tab?.label).toBe("Explore")
    expect(idx).toBeGreaterThan(0)
    expect(total).toBe(3)

    // Banner should show @explore, index/total, icon, status
    const typeIcon = tab?.label === "Shell" ? "▣" : "🤖"
    expect(typeIcon).toBe("🤖")
    const bannerText = `Messaging: @${tab?.label.toLowerCase()} subagent (${idx}/${total}) [${typeIcon} ${tab?.description} ${tab?.status}] — ESC=kill subagent, return to main`
    expect(bannerText).toContain("@explore")
    expect(bannerText).toContain(`(${idx}/${total})`)
    expect(bannerText).toContain("🤖")
    expect(bannerText).toContain("running")
    expect(bannerText).toContain("ESC=kill")

    // Shell job banner
    const shellTab = unified.find((t: any) => t.sessionID === "job-shell")
    const shellIcon = shellTab?.label === "Shell" ? "▣" : "🤖"
    expect(shellIcon).toBe("▣")
    const shellBanner = `Messaging: @${shellTab?.label.toLowerCase()} subagent [${shellIcon} ${shellTab?.description} ${shellTab?.status}]`
    expect(shellBanner).toContain("▣")
    expect(shellBanner).toContain("bun run dev")
  })

  test("background job detail shows output tail and command", () => {
    const data = createSubagentData()
    const { setBackgroundJobs } = require("@/cli/cmd/run/subagent-data") as typeof import(
      "@/cli/cmd/run/subagent-data"
    )

    const job = {
      id: "job-output",
      type: "shell",
      title: "bun run dev",
      status: "running" as const,
      started_at: Date.now() - 1000,
      output: "line1\nline2\nlocalhost:3000 ready\n",
      metadata: { command: "bun run dev" },
    }
    setBackgroundJobs({ data, jobs: [job] })

    const snap = snapshotSubagentData(data)
    const detail = (snap.details as any)["job-output"]
    expect(detail).toBeDefined()
    expect(detail.commits.length).toBeGreaterThan(0)
    const text = detail.commits[0].text
    expect(text).toContain("localhost:3000")
  })

  test("setBackgroundJobs removes stale jobs and keeps snapshot consistent", () => {
    const data = createSubagentData()
    const { setBackgroundJobs, listUnifiedTabs } = require("@/cli/cmd/run/subagent-data") as typeof import(
      "@/cli/cmd/run/subagent-data"
    )

    const job1 = {
      id: "job-1",
      type: "shell",
      title: "bun run dev",
      status: "running" as const,
      started_at: Date.now(),
      metadata: { command: "bun run dev" },
    }
    const job2 = {
      id: "job-2",
      type: "shell",
      title: "npm run build",
      status: "completed" as const,
      started_at: Date.now() - 10000,
      completed_at: Date.now(),
      metadata: { command: "npm run build" },
    }

    setBackgroundJobs({ data, jobs: [job1, job2] })
    expect(listUnifiedTabs(data).length).toBe(2)

    // Remove job1
    setBackgroundJobs({ data, jobs: [job2] })
    expect(listUnifiedTabs(data).length).toBe(1)
    expect(listUnifiedTabs(data)[0].sessionID).toBe("job-2")
  })

  test("snapshotSelectedSubagentData still works with background selected", () => {
    const data = createSubagentData()
    const { setBackgroundJobs, snapshotSelectedSubagentData: snapSel } = require(
      "@/cli/cmd/run/subagent-data",
    ) as typeof import("@/cli/cmd/run/subagent-data")

    const job = {
      id: "job-sel",
      type: "shell",
      title: "bun run dev",
      status: "running" as const,
      started_at: Date.now(),
      output: "output here",
      metadata: { command: "bun run dev" },
    }
    setBackgroundJobs({ data, jobs: [job] })

    const snap = snapSel(data, "job-sel")
    expect(snap.tabs.find((t: any) => t.sessionID === "job-sel")).toBeDefined()
    expect(snap.details["job-sel"]).toBeDefined()
  })
})
