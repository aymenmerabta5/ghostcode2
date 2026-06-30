import { Effect } from "effect"
import os from "os"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@opencode-ai/core/flag/flag"

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) =>
    withNetworkOptions(yargs).option("anthropic", {
      type: "boolean",
      describe: "expose an Anthropic-compatible API at /api/anthropic",
      default: false,
    }),
  describe: "starts a headless opencode server",
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    const { warmupAnthropicProvider } = yield* Effect.promise(() => import("../../server/routes/anthropic"))
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const anthropicDirectory = process.env.GHOSTCODE_ANTHROPIC_DIRECTORY ?? os.homedir()
    if (args.anthropic) {
      ;(opts as Record<string, unknown>).anthropic = true
      ;(opts as Record<string, unknown>).anthropicDirectory = anthropicDirectory
    }
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)
    if (args.anthropic) {
      console.log(`Anthropic API available at http://${server.hostname}:${server.port}/api/anthropic`)
      void warmupAnthropicProvider(anthropicDirectory)
    }

    yield* Effect.never
  }),
})
