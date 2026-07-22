import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Schema } from "effect"
import type * as Scope from "effect/Scope"
import path from "path"
import { Config } from "@/config/config"
import { Shell } from "@opencode-ai/core/shell"
import { ShellTool, Parameters } from "../../src/tool/shell"
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

const shellLayer = Layer.mergeAll(
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

const it = testEffect(shellLayer)

type ShellTestServices =
  | (typeof shellLayer extends Layer.Layer<infer ROut, infer _E, infer _RIn> ? ROut : never)
  | InstanceStore.Service
  | Scope.Scope

const initShell = Effect.fn("ShellToolTest.init")(function* () {
  const info = yield* ShellTool
  return yield* info.init()
})

const run = Effect.fn("ShellToolTest.run")(function* (
  args: Tool.InferParameters<typeof ShellTool>,
  next: Tool.Context = ctx,
) {
  const bash = yield* initShell()
  return yield* bash.execute(args, next)
})

const runIn = <A, E, R>(directory: string, self: Effect.Effect<A, E, R>) => self.pipe(provideInstance(directory))

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

Shell.acceptable.reset()
const projectRoot = path.join(__dirname, "../..")
const bin = `"${process.execPath.replaceAll("\\", "/")}"`
const sh = () => Shell.name(Shell.acceptable())
const PS = new Set(["pwsh", "powershell"])
const evalarg = (text: string) => (sh() === "cmd" ? `"${text}"` : `'${text}'`)
const mkCmd = (code: string) => {
  const text = `${bin} -e ${evalarg(code)}`
  if (PS.has(sh())) return `& ${text}`
  return text
}

describe("tool.shell background param", () => {
  it.live("background param exists in schema", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const decoded = Schema.decodeUnknownSync(Parameters)({
          command: "echo hi",
          background: true,
          description: "my dev server",
        })
        expect(decoded.background).toBe(true)
        expect(decoded.description).toBe("my dev server")
        expect(decoded.command).toBe("echo hi")

        const decoded2 = Schema.decodeUnknownSync(Parameters)({
          command: "echo hi",
        })
        expect(decoded2.background).toBeUndefined()

        const tool = yield* initShell()
        const p = tool.parameters as any
        expect(p).toBeDefined()
        const toolDecoded = Schema.decodeUnknownSync(tool.parameters as any)({
          command: "echo hi",
          background: true,
        })
        expect((toolDecoded as any).background).toBe(true)
      }),
    ),
  )

  it.live("background:true returns immediately with jobId and doesn't block", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const bg = yield* BackgroundJob.Service
        yield* run({ command: "echo warmup" }).pipe(Effect.ignore)

        const start = Date.now()
        const cmd = mkCmd("setInterval(()=>{}, 1000)")
        const result = yield* run({
          command: cmd,
          background: true,
          description: "test sleep",
        })
        const elapsed = Date.now() - start
        // After startup failure detection fix, background start waits up to 5s to detect early failure
        expect(elapsed).toBeLessThan(8000)
        expect((result.metadata as any).background).toBe(true)
        const jobId = (result.metadata as any).jobId as string
        expect(jobId).toBeTruthy()
        expect(typeof jobId).toBe("string")
        expect(result.output).toContain("working in the background")
        expect(result.output).toContain(jobId)
        expect(result.output).toContain("background_list")
        expect(result.output).toContain("background_output")
        expect(result.output).toContain("background_kill")

        const listed = yield* bg.list()
        const found = listed.find((j) => j.id === jobId)
        expect(found).toBeDefined()
        expect(found?.type).toBe("shell")
        expect(found?.title).toBe("test sleep")
        expect(found?.status).toBe("running")

        yield* bg.cancel(jobId)
        const after = yield* bg.get(jobId)
        expect(after?.status).toBe("cancelled")
      }),
    ),
  )

  it.live("background with description fallback to command slice", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const bg = yield* BackgroundJob.Service
        const cmd = mkCmd("setInterval(()=>{}, 1000)")
        const result = yield* run({
          command: cmd,
          background: true,
        })
        const jobId = (result.metadata as any).jobId as string
        const listed = yield* bg.list()
        const found = listed.find((j) => j.id === jobId)
        expect(found?.title).toBe(cmd.slice(0, 50))

        yield* bg.cancel(jobId)
      }),
    ),
  )

  it.live("foreground still works", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const result = yield* run({
          command: "echo foreground_ok",
        })
        expect(result.metadata.exit).toBe(0)
        expect(result.output).toContain("foreground_ok")
        expect((result.metadata as any).background).toBeUndefined()
      }),
    ),
  )

  it.live("background job output can be waited for", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const bg = yield* BackgroundJob.Service
        const cmd = mkCmd('console.log("hello_bg")')
        const result = yield* run({
          command: cmd,
          background: true,
          description: "quick bg",
        })
        const jobId = (result.metadata as any).jobId as string

        const waited = yield* bg.wait({ id: jobId, timeout: 5000 })
        expect(waited.timedOut).toBe(false)
        expect(waited.info?.status).toBe("completed")
        expect(waited.info?.output).toContain("hello_bg")
      }),
    ),
  )

  it.live("background:false behaves like foreground", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const result = yield* run({
          command: "echo explicit_foreground",
          background: false,
        })
        expect(result.output).toContain("explicit_foreground")
        expect((result.metadata as any).background).toBeUndefined()
      }),
    ),
  )
})
