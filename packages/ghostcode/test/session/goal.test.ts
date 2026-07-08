import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Goal } from "@/session/goal"
import { Session as SessionNs } from "@/session/session"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EventV2Bridge } from "@/event-v2-bridge"
import { GlobalBus } from "@/bus/global"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Goal.node,
      SessionNs.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

describe("goal service", () => {
  it.instance("set and get a goal", () =>
    Effect.gen(function* () {
      const goals = yield* Goal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      const goal = yield* goals.set({ sessionID: session.id, text: "Write tests for the goal feature" })
      expect(goal.text).toBe("Write tests for the goal feature")
      expect(goal.status).toBe("active")
      expect(goal.tokensUsed).toBe(0)
      expect(goal.timeMs).toBe(0)
      expect(goal.startedAt).toBeGreaterThan(0)

      const retrieved = yield* goals.get(session.id)
      expect(retrieved).toBeDefined()
      expect(retrieved!.text).toBe("Write tests for the goal feature")
      expect(retrieved!.status).toBe("active")

      yield* sessions.remove(session.id)
    }),
  )

  it.instance("pause and resume a goal", () =>
    Effect.gen(function* () {
      const goals = yield* Goal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      yield* goals.set({ sessionID: session.id, text: "Fix the bug" })
      const paused = yield* goals.pause(session.id)
      expect(paused).toBeDefined()
      expect(paused!.status).toBe("paused")
      expect(paused!.pausedAt).toBeDefined()

      const resumed = yield* goals.resume(session.id)
      expect(resumed).toBeDefined()
      expect(resumed!.status).toBe("active")
      expect(resumed!.pausedAt).toBeUndefined()

      yield* sessions.remove(session.id)
    }),
  )

  it.instance("complete a goal with verification", () =>
    Effect.gen(function* () {
      const goals = yield* Goal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      yield* goals.set({ sessionID: session.id, text: "Deploy to production" })
      const completed = yield* goals.update({
        sessionID: session.id,
        status: "completed",
        verification: "Deployed v1.0.0 to production, all checks green",
      })
      expect(completed).toBeDefined()
      expect(completed!.status).toBe("completed")
      expect(completed!.completedAt).toBeDefined()
      expect(completed!.verification).toBe("Deployed v1.0.0 to production, all checks green")

      yield* sessions.remove(session.id)
    }),
  )

  it.instance("record usage accumulates tokens and time", () =>
    Effect.gen(function* () {
      const goals = yield* Goal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      yield* goals.set({ sessionID: session.id, text: "Build the feature" })
      yield* goals.recordUsage({ sessionID: session.id, tokens: 500, durationMs: 3000 })
      yield* goals.recordUsage({ sessionID: session.id, tokens: 300, durationMs: 2000 })

      const goal = yield* goals.get(session.id)
      expect(goal).toBeDefined()
      expect(goal!.tokensUsed).toBe(800)
      expect(goal!.timeMs).toBe(5000)

      yield* sessions.remove(session.id)
    }),
  )

  it.instance("clear removes the goal", () =>
    Effect.gen(function* () {
      const goals = yield* Goal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      yield* goals.set({ sessionID: session.id, text: "Temporary goal" })
      yield* goals.clear(session.id)

      const goal = yield* goals.get(session.id)
      expect(goal).toBeUndefined()

      yield* sessions.remove(session.id)
    }),
  )

  it.instance("set with budget tokens overrides default", () =>
    Effect.gen(function* () {
      const goals = yield* Goal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      const goal = yield* goals.set({ sessionID: session.id, text: "Budgeted goal", budgetTokens: 50000 })
      expect(goal.budgetTokens).toBe(50000)

      yield* sessions.remove(session.id)
    }),
  )

  it.instance("set replaces an existing goal", () =>
    Effect.gen(function* () {
      const goals = yield* Goal.Service
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({})

      yield* goals.set({ sessionID: session.id, text: "First goal" })
      yield* goals.recordUsage({ sessionID: session.id, tokens: 1000, durationMs: 5000 })
      const goal = yield* goals.set({ sessionID: session.id, text: "Second goal" })
      expect(goal.text).toBe("Second goal")
      expect(goal.status).toBe("active")
      expect(goal.tokensUsed).toBe(0)
      expect(goal.timeMs).toBe(0)

      yield* sessions.remove(session.id)
    }),
  )
})
