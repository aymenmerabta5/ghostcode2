// @ts-nocheck
import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Exit, Schema } from "effect"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Truncate.node, Agent.node])))

const params = Schema.Struct({ input: Schema.String })

function makeCtx(): Tool.Context {
  return {
    sessionID: SessionID.descending(),
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata() {
      return Effect.void
    },
    ask() {
      return Effect.void
    },
  }
}

function makeTool(id: string, executeFn?: () => void) {
  return {
    description: "test tool",
    parameters: params,
    execute() {
      executeFn?.()
      return Effect.succeed({ title: "test", output: "ok", metadata: {} })
    },
  }
}

describe("Tool.define", () => {
  it.effect("object-defined tool does not mutate the original init object", () =>
    Effect.gen(function* () {
      const original = makeTool("test")
      const originalExecute = original.execute

      const info = yield* Tool.define("test-tool", Effect.succeed(original))

      yield* info.init()
      yield* info.init()
      yield* info.init()

      expect(original.execute).toBe(originalExecute)
    }),
  )

  it.effect("effect-defined tool returns fresh objects and is unaffected", () =>
    Effect.gen(function* () {
      const info = yield* Tool.define(
        "test-fn-tool",
        Effect.succeed(() => Effect.succeed(makeTool("test"))),
      )

      const first = yield* info.init()
      const second = yield* info.init()

      expect(first).not.toBe(second)
    }),
  )

  it.effect("object-defined tool returns distinct objects per init() call", () =>
    Effect.gen(function* () {
      const info = yield* Tool.define("test-copy", Effect.succeed(makeTool("test")))

      const first = yield* info.init()
      const second = yield* info.init()

      expect(first).not.toBe(second)
    }),
  )

  it.effect("execute receives decoded parameters", () =>
    Effect.gen(function* () {
      const parameters = Schema.Struct({
        count: Schema.NumberFromString.pipe(Schema.optional, Schema.withDecodingDefaultType(Effect.succeed(5))),
      })
      const calls: Array<Schema.Schema.Type<typeof parameters>> = []
      const info = yield* Tool.define(
        "test-decoded",
        Effect.succeed({
          description: "test tool",
          parameters,
          execute(args: Schema.Schema.Type<typeof parameters>) {
            calls.push(args)
            return Effect.succeed({ title: "test", output: "ok", metadata: { truncated: false } })
          },
        }),
      )
      const ctx = makeCtx()
      const tool = yield* info.init()
      const execute = tool.execute as unknown as (args: unknown, ctx: Tool.Context) => ReturnType<typeof tool.execute>

      yield* execute({}, ctx)
      yield* execute({ count: "7" }, ctx)

      expect(calls).toEqual([{ count: 5 }, { count: 7 }])
    }),
  )

  // Regression for #28438 + subagent interactive control fix:
  // Malformed tool calls (invalid args) must NOT kill the fiber/session.
  // The wrap should catch ToolInvalidArgumentsError and return a model-facing
  // error result with metadata.error=true, output containing tool name,
  // invalid arguments phrase, rewrite suggestion, and JSON path where applicable.
  it.effect("invalid args returns error output not defect - session stays alive", () =>
    Effect.gen(function* () {
      const parameters = Schema.Struct({
        questions: Schema.Array(
          Schema.Struct({
            question: Schema.String,
            options: Schema.Array(Schema.String),
          }),
        ),
      })
      const info = yield* Tool.define(
        "qtest",
        Effect.succeed({
          description: "test tool",
          parameters,
          execute() {
            return Effect.succeed({ title: "ok", output: "ok", metadata: { truncated: false } })
          },
        }),
      )
      const tool = yield* info.init()
      const execute = tool.execute as unknown as (args: unknown, ctx: Tool.Context) => ReturnType<typeof tool.execute>

      // Missing required `question` field on first array entry — malformed LLM call
      const exit = yield* execute({ questions: [{ options: ["a"] }] }, makeCtx()).pipe(Effect.exit)

      // MUST be Success (not Failure/Defect) — session not killed
      expect(Exit.isSuccess(exit)).toBe(true)
      if (!Exit.isSuccess(exit)) return

      const result = exit.value as Tool.ExecuteResult<any>
      // Strong assertions mirroring real-world LLM recovery need
      expect(result.title).toBe("qtest")
      expect(result.metadata.error).toBe(true)
      expect(result.output).toContain("qtest") // tool name in message
      expect(result.output.toLowerCase()).toContain("invalid arguments") // phrase
      expect(result.output).toContain("Please rewrite the input") // actionable suggestion
      expect(result.output).toContain(`["questions"][0]["question"]`) // JSON path guidance

      // Session stays alive: subsequent valid call should succeed normally
      const validExit = yield* execute({ questions: [{ question: "what?", options: ["a", "b"] }] }, makeCtx()).pipe(
        Effect.exit,
      )
      expect(Exit.isSuccess(validExit)).toBe(true)
      if (!Exit.isSuccess(validExit)) return
      expect((validExit.value as any).output).toBe("ok")
      expect((validExit.value as any).metadata.truncated).toBe(false)
    }),
  )

  it.effect("invalid args with wrong field name returns error with rewrite guidance", () =>
    Effect.gen(function* () {
      const info = yield* Tool.define(
        "badtest",
        Effect.succeed({
          description: "test tool with required field",
          parameters: Schema.Struct({ must: Schema.String }),
          execute() {
            return Effect.succeed({ title: "ok", output: "ok", metadata: {} } as any)
          },
        }),
      )
      const def = yield* info.init()
      const execute = def.execute as unknown as (args: unknown, ctx: Tool.Context) => ReturnType<typeof def.execute>

      // Call with wrong field name — simulates LLM hallucination like glob with bad args
      const exit = yield* execute({ wrong: "x" } as any, makeCtx()).pipe(Effect.exit)

      expect(Exit.isSuccess(exit)).toBe(true)
      if (!Exit.isSuccess(exit)) return

      const result = exit.value as Tool.ExecuteResult<any>
      expect(result.title).toBe("badtest")
      expect(result.metadata.error).toBe(true)
      expect(result.output).toContain("badtest tool was called with invalid arguments")
      expect(result.output.toLowerCase()).toContain("invalid arguments")
      expect(result.output).toContain("Please rewrite the input")
      // Should mention the missing or expected field
      expect(result.output.toLowerCase()).toContain("must")
    }),
  )

  it.effect("Tool.InvalidArgumentsError class is properly tagged and exported", () =>
    Effect.gen(function* () {
      const err = new Tool.InvalidArgumentsError({ tool: "glob", detail: "test detail" })
      expect(err._tag).toBe("ToolInvalidArgumentsError")
      expect(err.tool).toBe("glob")
      expect(err.detail).toBe("test detail")
      expect(err.message).toContain("glob tool was called with invalid arguments")
      expect(err.message).toContain("test detail")
      expect(err.message).toContain("Please rewrite the input")
      expect(err).toBeInstanceOf(Tool.InvalidArgumentsError)
    }),
  )

  it.effect("valid args still succeed without error metadata", () =>
    Effect.gen(function* () {
      const parameters = Schema.Struct({ input: Schema.String })
      const info = yield* Tool.define(
        "validcheck",
        Effect.succeed({
          description: "test",
          parameters,
          execute(args) {
            return Effect.succeed({
              title: "validcheck",
              output: `got ${args.input}`,
              metadata: { truncated: false },
            })
          },
        }),
      )
      const tool = yield* info.init()
      const execute = tool.execute as unknown as (args: unknown, ctx: Tool.Context) => ReturnType<typeof tool.execute>

      const exit = yield* execute({ input: "hello" }, makeCtx()).pipe(Effect.exit)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (!Exit.isSuccess(exit)) return
      const result = exit.value as Tool.ExecuteResult<any>
      expect(result.output).toBe("got hello")
      expect((result.metadata as any).error).toBeUndefined()
      expect(result.title).toBe("validcheck")
    }),
  )
})
