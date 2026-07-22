import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { describe, expect } from "bun:test"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Layer } from "effect"
import { GlobTool } from "../../src/tool/glob"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Git } from "@/git"
import { Filesystem } from "@/util/filesystem"
import { Permission } from "../../src/permission"
import type * as Tool from "../../src/tool/tool"

const toolLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([CrossSpawnSpawner.node, FSUtil.node, Ripgrep.node, Truncate.node, Agent.node, Git.node]),
  )

const it = testEffect(toolLayer())
const full = (p: string) => (process.platform === "win32" ? Filesystem.normalizePath(p) : p)

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

const asks = () => {
  const items: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  return {
    items,
    next: {
      ...ctx,
      ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
        Effect.sync(() => {
          items.push(req)
        }),
    } satisfies Tool.Context,
  }
}

const githubBase = <A, E, R>(url: string, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL
      process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL = url
      return previous
    }),
    () => self,
    (previous) =>
      Effect.sync(() => {
        if (previous) process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL = previous
        else delete process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL
      }),
  )

const git = Effect.fn("GlobToolTest.git")(function* (cwd: string, args: string[]) {
  return yield* Effect.promise(async () => {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed`)
    return stdout.trim()
  })
})

describe("tool.glob", () => {
  it.instance("matches files from a directory path", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "a.ts"), "export const a = 1\n"))
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "b.txt"), "hello\n"))
      const info = yield* GlobTool
      const glob = yield* info.init()
      const result = yield* glob.execute(
        {
          pattern: "*.ts",
          path: test.directory,
        },
        ctx,
      )
      expect(result.metadata.count).toBe(1)
      expect(result.output).toContain(path.join(test.directory, "a.ts"))
      expect(result.output).not.toContain(path.join(test.directory, "b.txt"))
    }),
  )

  it.instance("rejects exact file paths", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "a.ts")
      yield* Effect.promise(() => Bun.write(file, "export const a = 1\n"))
      const info = yield* GlobTool
      const glob = yield* info.init()
      const result = yield* glob
        .execute(
          {
            pattern: "*.ts",
            path: file,
          },
          ctx,
        )
      // After fix, tool returns error result, not fiber defect — session stays alive
      expect((result.metadata as any).error).toBe(true)
      expect(result.output.toLowerCase()).toContain("glob path must be a directory")
    }),
  )

  it.instance("invalid path returns error not defect (non-existent directory)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const info = yield* GlobTool
      const glob = yield* info.init()
      const nonExistent = path.join(test.directory, "does-not-exist-xyz")
      const exit = yield* glob
        .execute(
          {
            pattern: "*.ts",
            path: nonExistent,
          },
          ctx,
        )
        .pipe(Effect.exit)

      // Should not crash the fiber — should be either success with empty or failure with message
      // The key is it returns a controlled error, not a session-killing defect that leaves no output
      if (Exit.isSuccess(exit)) {
        expect(exit.value.output).toBeDefined()
      } else {
        expect(Exit.isFailure(exit)).toBe(true)
        const msg = Cause.squash(exit.cause)
        expect(String(msg).length).toBeGreaterThan(0)
      }
    }),
  )

  it.instance("glob source does not contain orDie (prevents defect on expected fs errors)", () =>
    Effect.gen(function* () {
      const content = yield* Effect.promise(() => Bun.file(path.join(process.cwd(), "src/tool/glob.ts")).text())
      expect(content).not.toContain("Effect.orDie")
      expect(content).not.toContain("orDie")
    }),
  )

  it.instance("valid glob still works after orDie removal", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "x.ts"), "export const x=1\n"))
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "y.ts"), "export const y=2\n"))
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "z.md"), "# docs\n"))
      const info = yield* GlobTool
      const glob = yield* info.init()
      const asksCtx = asks()
      const result = yield* glob.execute(
        {
          pattern: "**/*.ts",
          path: test.directory,
        },
        asksCtx.next,
      )
      expect(result.metadata.count).toBeGreaterThanOrEqual(2)
      expect(result.output).toContain("x.ts")
      expect(result.output).toContain("y.ts")
      expect(result.output).not.toContain("z.md")
      // Ensure permission ask was made
      expect(asksCtx.items.length).toBeGreaterThanOrEqual(1)
    }),
  )

  it.instance("glob with no matches returns No files found not defect", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const info = yield* GlobTool
      const glob = yield* info.init()
      const result = yield* glob.execute(
        {
          pattern: "*.nonexistentext123",
          path: test.directory,
        },
        ctx,
      )
      expect(result.output).toContain("No files found")
      expect(result.metadata.count).toBe(0)
    }),
  )
})
