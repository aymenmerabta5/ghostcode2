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
  // Server loads instances per-request via x-opencode-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const base = yield* resolveNetworkOptions(args)
    const anthropicDirectory =
      process.env.OPENCODE_ANTHROPIC_DIRECTORY ?? process.env.GHOSTCODE_ANTHROPIC_DIRECTORY ?? os.homedir()
    const opts = args.anthropic
      ? { ...base, anthropic: true as const, anthropicDirectory }
      : { ...base, anthropic: false as const }
    const { warmupAnthropicProvider } = yield* Effect.promise(() => import("../../server/routes/anthropic"))
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)
    if (args.anthropic) {
      console.log(`Anthropic API available at http://${server.hostname}:${server.port}/api/anthropic`)
      void warmupAnthropicProvider(anthropicDirectory)
    }

    yield* Effect.never
  }),
})
