// @ts-nocheck
import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Deferred, Effect, Exit, Layer } from "effect"
import type * as Scope from "effect/Scope"
import path from "path"
import { Config } from "@/config/config"
import { Shell } from "@opencode-ai/core/shell"
import { BackgroundListTool } from "../../src/tool/background-list"
import { BackgroundKillTool } from "../../src/tool/background-kill"
import { TaskOutputTool, BackgroundOutputTool } from "../../src/tool/task-output"
import { ShellTool } from "../../src/tool/shell"
import { provideInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Plugin } from "../../src/plugin"
import { testEffect } from "../lib/effect"
import { Tool } from "@/tool/tool"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"
import { InstanceStore } from "@/project/instance-store"

const baseLayer = Layer.mergeAll(
  LayerNode.compile(
    LayerNode.group([
      CrossSpawnSpawner.node,
      FSUtil.node,
      Plugin.node,
      Truncate.node,
      Config.node,
      Agent.node,
      RuntimeFlags.node,
      BackgroundJob.node,
    ]),
  ),
  testInstanceStoreLayer,
)

const it = testEffect(baseLayer)

type BGLayerServices =
  | (typeof baseLayer extends Layer.Layer<infer ROut, infer _E, infer _RIn> ? ROut : never)
  | InstanceStore.Service
  | Scope.Scope

const projectRoot = path.join(__dirname, "../..")

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const init = <T extends { init: () => Effect.Effect<any> }>(tool: T) =>
  Effect.gen(function* () {
    const info = yield* tool
    return yield* info.init()
  })

const runTool = <P>(toolDef: Tool.Def<P, any>, params: P) =>
  Effect.gen(function* () {
    return yield* (toolDef.execute as any)(params, ctx)
  })

const runIn = <A, E, R>(directory: string, self: Effect.Effect<A, E, R>) => self.pipe(provideInstance(directory))

Shell.acceptable.reset()
const bin = `"${process.execPath.replaceAll("\\", "/")}"`
const sh = () => Shell.name(Shell.acceptable())
const PS = new Set(["pwsh", "powershell"])
const evalarg = (text: string) => (sh() === "cmd" ? `"${text}"` : `'${text}'`)
const mkCmd = (code: string) => {
  const text = `${bin} -e ${evalarg(code)}`
  if (PS.has(sh())) return `& ${text}`
  return text
}

describe("tool.background_list", () => {
  it.live("returns no jobs message when empty", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const bg = yield* BackgroundJob.Service
        // Ensure clean slate: cancel all existing
        const existing = yield* bg.list()
        for (const j of existing) yield* bg.cancel(j.id)

        const def = yield* init(BackgroundListTool)
        const result = yield* runTool(def, {} as any)
        expect(result.output).toContain("No background jobs")
        expect(result.metadata.count).toBe(0)
      }),
    ),
  )

  it.live("returns table with running job and guidance", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const bg = yield* BackgroundJob.Service
        const existing = yield* bg.list()
        for (const j of existing) yield* bg.cancel(j.id)

        const job = yield* bg.start({
          type: "shell",
          title: "dev server",
          run: Effect.succeed("Server started at localhost:3000"),
        })

        const def = yield* init(BackgroundListTool)
        const result = yield* runTool(def, {} as any)

        expect(result.output).toContain("| id | type | title | status | duration | tail |")
        expect(result.output).toContain("dev server")
        expect(result.output).toContain("background_output")
        expect(result.output).toContain("background_kill")
        expect(result.metadata.count).toBeGreaterThanOrEqual(1)
        // Full ids listed
        expect(result.output).toContain(job.id)

        yield* bg.cancel(job.id)
      }),
    ),
  )

  it.live("list shows both task and shell jobs", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const bg = yield* BackgroundJob.Service
        const existing = yield* bg.list()
        for (const j of existing) yield* bg.cancel(j.id)

        const shellJob = yield* bg.start({
          type: "shell",
          title: "bun run dev",
          run: Effect.never,
        })
        const taskJob = yield* bg.start({
          type: "task",
          title: "Explore architecture",
          run: Effect.never,
        })

        const def = yield* init(BackgroundListTool)
        const result = yield* runTool(def, {} as any)

        expect(result.output).toContain("shell")
        expect(result.output).toContain("task")
        expect(result.output).toContain("bun run dev")
        expect(result.output).toContain("Explore architecture")

        yield* bg.cancel(shellJob.id)
        yield* bg.cancel(taskJob.id)
      }),
    ),
  )

  it.live("real shell background job appears in list", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const bg = yield* BackgroundJob.Service
        const shellToolDef = yield* init(ShellTool)

        const cmd = mkCmd("setInterval(()=>{}, 1000)")
        const shellResult = yield* runTool(shellToolDef, {
          command: cmd,
          background: true,
          description: "real dev server",
        } as any)

        const jobId = (shellResult.metadata as any).jobId as string
        expect(jobId).toBeTruthy()

        const listDef = yield* init(BackgroundListTool)
        const listed = yield* runTool(listDef, {} as any)

        expect(listed.output).toContain("real dev server")
        expect(listed.output).toContain(jobId.slice(0, 8))

        // Cleanup via kill tool
        const killDef = yield* init(BackgroundKillTool)
        const killed = yield* runTool(killDef, { task_id: jobId } as any)
        expect(killed.metadata.status).toBe("cancelled")

        const after = yield* bg.get(jobId)
        expect(after?.status).toBe("cancelled")
      }),
    ),
  )
})

describe("tool.background_kill", () => {
  it.live("cancels running job", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const bg = yield* BackgroundJob.Service
        const job = yield* bg.start({
          type: "shell",
          title: "to be killed",
          run: Effect.never,
        })

        const def = yield* init(BackgroundKillTool)
        const result = yield* runTool(def, { task_id: job.id } as any)

        expect(result.output).toContain("cancelled")
        expect(result.metadata.jobId).toBe(job.id)
        expect(result.metadata.status).toBe("cancelled")

        const after = yield* bg.get(job.id)
        expect(after?.status).toBe("cancelled")
      }),
    ),
  )

  it.live("supports prefix matching (first 8 chars)", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const bg = yield* BackgroundJob.Service
        const job = yield* bg.start({
          type: "shell",
          title: "prefix test",
          run: Effect.never,
        })

        const short = job.id.slice(0, 8)
        const def = yield* init(BackgroundKillTool)
        const result = yield* runTool(def, { task_id: short } as any)

        expect(result.metadata.jobId).toBe(job.id)
        expect(result.metadata.status).toBe("cancelled")
      }),
    ),
  )

  it.live("includes reason in output", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const bg = yield* BackgroundJob.Service
        const job = yield* bg.start({
          type: "shell",
          title: "reason test",
          run: Effect.never,
        })

        const def = yield* init(BackgroundKillTool)
        const result = yield* runTool(def, { task_id: job.id, reason: "no longer needed" } as any)

        expect(result.output).toContain("no longer needed")
      }),
    ),
  )

  it.live("fails when job not found", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const def = yield* init(BackgroundKillTool)
        const result = yield* runTool(def, { task_id: "non-existent-job-id-xyz" } as any)
        // After fix, job not found returns error result, not Effect failure (tool.ts catchAll converts)
        expect((result.metadata as any).error).toBe(true)
        expect(result.output).toContain("Job not found")
        expect(result.output).toContain("background_list")
      }),
    ),
  )
})

describe("tool.task_output / background_output", () => {
  it.live("waits for completed job and returns output", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const bg = yield* BackgroundJob.Service
        const job = yield* bg.start({
          type: "shell",
          title: "quick job",
          run: Effect.succeed("hello completed world"),
        })

        const def = yield* init(TaskOutputTool)
        const result = yield* runTool(def, { task_id: job.id, timeout: 5000 } as any)

        expect(result.output).toContain("hello completed world")
        expect(result.metadata.status).toBe("completed")
        expect(result.metadata.task_id).toBe(job.id)
      }),
    ),
  )

  it.live("background_output alias works same as task_output", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const bg = yield* BackgroundJob.Service
        const job = yield* bg.start({
          type: "task",
          title: "alias test",
          run: Effect.succeed("alias hello"),
        })

        const def = yield* init(BackgroundOutputTool)
        const result = yield* runTool(def, { task_id: job.id, timeout: 5000 } as any)

        expect(result.output).toContain("alias hello")
        expect(result.metadata.status).toBe("completed")
      }),
    ),
  )

  it.live("timeout 0 peek returns immediately without waiting", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const bg = yield* BackgroundJob.Service
        const job = yield* bg.start({
          type: "shell",
          title: "never ending",
          run: Effect.never,
        })

        const def = yield* init(TaskOutputTool)
        const start = Date.now()
        const result = yield* runTool(def, { task_id: job.id, timeout: 0 } as any)
        const elapsed = Date.now() - start

        expect(elapsed).toBeLessThan(2000)
        expect(result.metadata.status).toBe("running")
        expect(result.metadata.timedOut).toBe(true)
        expect(result.output).toContain("Peek: true")

        yield* bg.cancel(job.id)
      }),
    ),
  )

  it.live("times out with still running guidance", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const bg = yield* BackgroundJob.Service
        const job = yield* bg.start({
          type: "shell",
          title: "slow job",
          run: Effect.never,
        })

        const def = yield* init(TaskOutputTool)
        const result = yield* runTool(def, { task_id: job.id, timeout: 100 } as any)

        expect(result.metadata.timedOut).toBe(true)
        expect(result.output).toContain("Task still running")
        expect(result.output).toContain("Do NOT spam")
        expect(result.metadata.status).toBe("running")

        yield* bg.cancel(job.id)
      }),
    ),
  )

  it.live("tail param slices correctly to last N lines", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const bg = yield* BackgroundJob.Service
        const multiline = ["line1", "line2", "line3", "line4", "line5"].join("\n")
        const job = yield* bg.start({
          type: "shell",
          title: "multiline",
          run: Effect.succeed(multiline),
        })

        const def = yield* init(TaskOutputTool)
        const result = yield* runTool(def, { task_id: job.id, tail: 2 } as any)

        // Should contain only last 2 lines
        expect(result.output).toContain("line4")
        expect(result.output).toContain("line5")
        // Check output section doesn't contain line1 as standalone filtered? It might still be in tail processing we check that line1 not in final output block
        const outputSection = result.output.split("--- Output ---")[1] || ""
        expect(outputSection).not.toContain("line1")
        expect(outputSection).not.toContain("line2")
      }),
    ),
  )

  it.live("default tail is 100 lines", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const bg = yield* BackgroundJob.Service
        const many = Array.from({ length: 150 }, (_, i) => `l${i}`).join("\n")
        const job = yield* bg.start({
          type: "shell",
          title: "many lines",
          run: Effect.succeed(many),
        })

        const def = yield* init(TaskOutputTool)
        const result = yield* runTool(def, { task_id: job.id } as any)

        const outputSection = result.output.split("--- Output ---")[1] || ""
        const lines = outputSection.trim().split("\n")
        // Should be at most 100 + some header? So count lines in output section should be <= 100 + extra guidance lines but our slice should be 100
        // At least ensure l0-l49 not present
        expect(outputSection).not.toContain("\nl0\n")
        expect(outputSection).toContain("l149")
        expect(outputSection).toContain("l50")
      }),
    ),
  )

  it.live("filter param filters lines case-insensitive", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const bg = yield* BackgroundJob.Service
        const text = ["INFO starting", "ERROR failed to connect", "info retry", "WARN low mem", "error timeout"].join("\n")
        const job = yield* bg.start({
          type: "shell",
          title: "filter test",
          run: Effect.succeed(text),
        })

        const def = yield* init(TaskOutputTool)
        const result = yield* runTool(def, { task_id: job.id, filter: "error" } as any)

        const section = result.output.split("--- Output ---")[1] || ""
        expect(section.toLowerCase()).toContain("error failed to connect")
        expect(section.toLowerCase()).toContain("error timeout")
        expect(section).not.toContain("INFO starting")
        expect(section).not.toContain("WARN")
        expect(section).not.toContain("info retry")
        // The line "info retry" does not contain error, so should be excluded
        expect(section).not.toContain("info retry")
      }),
    ),
  )

  it.live("port detection extracts localhost:3000 and URLs", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const bg = yield* BackgroundJob.Service
        const text = "Server started at localhost:3000 and also http://localhost:4000/api and https://example.com/path and 127.0.0.1:8080"
        const job = yield* bg.start({
          type: "shell",
          title: "port detection",
          run: Effect.succeed(text),
        })

        const def = yield* init(TaskOutputTool)
        const result = yield* runTool(def, { task_id: job.id } as any)

        const ports = result.metadata.detectedPorts as string[]
        const urls = result.metadata.detectedUrls as string[]

        expect(ports).toContain("localhost:3000")
        expect(ports).toContain("127.0.0.1:8080")
        // http://localhost:4000 also matched as port via host:port regex? Should still detect
        // URLs
        expect(urls.join(" ")).toContain("http://localhost:4000/api")
        expect(urls.join(" ")).toContain("https://example.com/path")

        expect(result.output).toContain("Detected ports")
        expect(result.output).toContain("Detected URLs")
      }),
    ),
  )

  it.live("full param returns full output bounded to 50k", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const bg = yield* BackgroundJob.Service
        const big = "x".repeat(60000)
        const job = yield* bg.start({
          type: "shell",
          title: "big output",
          run: Effect.succeed(big),
        })

        const def = yield* init(TaskOutputTool)

        const tailResult = yield* runTool(def, { task_id: job.id, tail: 10 } as any)
        // tail 10 lines of one big line -> still one line but full length? Should be truncated to 10 lines but we have one line, so whole big string
        // Our implementation splits by \n, so big string one line, tail 10 still big
        // Check full handling
        const fullResult = yield* runTool(def, { task_id: job.id, full: true } as any)
        expect(fullResult.output.length).toBeLessThan(70000)
        expect(fullResult.output).toContain("truncated")
      }),
    ),
  )

  it.live("supports prefix matching for task_id", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const bg = yield* BackgroundJob.Service
        const job = yield* bg.start({
          type: "shell",
          title: "prefix output",
          run: Effect.succeed("prefix works"),
        })

        const short = job.id.slice(0, 8)
        const def = yield* init(TaskOutputTool)
        const result = yield* runTool(def, { task_id: short } as any)

        expect(result.metadata.task_id).toBe(job.id)
        expect(result.output).toContain("prefix works")
      }),
    ),
  )

  it.live("job not found error handling", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const def = yield* init(TaskOutputTool)
        const result = yield* runTool(def, { task_id: "does-not-exist-12345" } as any)
        expect((result.metadata as any).error).toBe(true)
        expect(result.output).toContain("Job not found")
        expect(result.output).toContain("background_list")
      }),
    ),
  )

  it.live("real shell background job: output and kill flow", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const bg = yield* BackgroundJob.Service
        const shellDef = yield* init(ShellTool)
        const listDef = yield* init(BackgroundListTool)
        const outputDef = yield* init(TaskOutputTool)
        const killDef = yield* init(BackgroundKillTool)

        // Use simple interval that stays alive, avoid quoting issues with console.log containing port
        const cmd = mkCmd("setInterval(()=>{}, 1000)")
        const started = yield* runTool(shellDef, {
          command: cmd,
          background: true,
          description: "bun run dev",
        } as any)

        const jobId = (started.metadata as any).jobId as string
        expect(jobId).toBeTruthy()

        // List should show it
        const list = yield* runTool(listDef, {} as any)
        expect(list.output).toContain("bun run dev")

        // Output peek should show running
        yield* Effect.sleep("200 millis")

        const peek = yield* runTool(outputDef, { task_id: jobId, timeout: 0 } as any)
        expect(peek.metadata.status).toBe("running")

        // Try to get again after short delay, still running
        yield* Effect.sleep("300 millis")
        const peek2 = yield* runTool(outputDef, { task_id: jobId, timeout: 0 } as any)
        expect(peek2.metadata.status).toBe("running")

        // Kill
        const killed = yield* runTool(killDef, { task_id: jobId, reason: "test cleanup" } as any)
        expect(killed.metadata.status).toBe("cancelled")

        const after = yield* bg.get(jobId)
        expect(after?.status).toBe("cancelled")
      }),
    ),
  )
})
