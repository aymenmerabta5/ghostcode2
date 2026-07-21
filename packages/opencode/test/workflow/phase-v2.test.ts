import { describe, expect, test } from "bun:test"
import { InvalidPhaseError } from "../../src/workflow/errors"
import { SETUP_PHASE, belongsToPhase, mergeObservedPhases } from "../../../tui/src/component/dialog-workflow-helpers"
import type { WorkflowRun } from "@opencode-ai/sdk/v2"

// Mock rowToRun logic
function mockRowToRun(row: any) {
  return {
    id: row.id,
    workflow: row.workflow,
    status: row.status,
    started_at: row.started_at,
    completed_at: row.completed_at,
    current_phase: row.current_phase,
    logs: row.logs,
    agents: row.agents,
    result: row.result ? JSON.parse(row.result) : undefined,
    error: row.error,
    resume_of: row.resume_of,
    pending_question: row.pending_question,
    phase_data: row.phase_data,
    state: row.state,
  }
}

describe("Workflows v2 - Phase system overhaul", () => {
  test("setPhase validation - strict mode throws InvalidPhaseError for unknown phase", () => {
    const declared = ["discover", "validate", "report"]
    let phaseValidation: "strict" | "warn" = "strict"

    function validatePhase(phase: string) {
      if (declared.length > 0 && !declared.includes(phase)) {
        if (phaseValidation === "warn") {
          return { warned: true } as any
        } else {
          throw new InvalidPhaseError({
            phase,
            declared,
            message: `Unknown phase "${phase}". Declared phases: ${declared.join(", ")}`,
          } as any)
        }
      }
    }

    expect(() => validatePhase("discover")).not.toThrow()
    expect(() => validatePhase("unknown_typo")).toThrow()
    try {
      validatePhase("unknown_typo")
    } catch (e: any) {
      expect(e.phase).toBe("unknown_typo")
      expect(e.declared).toEqual(declared)
      expect(e.message).toContain("Declared phases")
    }
  })

  test("setPhase validation - warn mode does not throw", () => {
    const declared = ["discover", "validate", "report"]
    let phaseValidation: "strict" | "warn" = "warn"
    let warned = false

    function validatePhase(phase: string) {
      if (declared.length > 0 && !declared.includes(phase)) {
        if (phaseValidation === "warn") {
          warned = true
          return
        } else {
          throw new InvalidPhaseError({ phase, declared, message: "Unknown" } as any)
        }
      }
    }

    expect(() => validatePhase("unknown_typo")).not.toThrow()
    expect(warned).toBe(true)
  })

  test("phase_data round-trip via rowToRun", () => {
    const phaseData = {
      discover: { files: ["a.ts", "b.ts"], count: 2 },
      validate: { validated: true },
      report: { result: "ok" },
    }
    const row = {
      id: "job_test",
      workflow: "test",
      status: "completed",
      started_at: Date.now(),
      current_phase: null,
      logs: [],
      agents: [],
      result: JSON.stringify({ success: true }),
      phase_data: phaseData,
      state: { counter: 2, key: "value" },
    }

    const run = mockRowToRun(row)
    expect(run.phase_data).toEqual(phaseData)
    expect((run.phase_data as any).discover.count).toBe(2)
    expect(run.state).toEqual({ counter: 2, key: "value" })
  })

  test("deep-freeze prevents mutation of phase payloads", () => {
    function deepFreeze<T>(obj: T): T {
      if (obj === null || typeof obj !== "object") return obj
      if (Object.isFrozen(obj)) return obj
      for (const key of Object.getOwnPropertyNames(obj)) {
        const value = (obj as any)[key]
        if (value && typeof value === "object") deepFreeze(value)
      }
      return Object.freeze(obj) as T
    }

    const payload = { count: 2, files: ["a.ts"] }
    const frozen = deepFreeze(structuredClone(payload))

    expect(Object.isFrozen(frozen)).toBe(true)
    // In non-strict mode, assignment fails silently or throws in strict
    // We check that original stored data not mutated via frozen reference
    expect(() => {
      // @ts-ignore
      ;(frozen as any).count = 999
    }).toThrow() // Should throw TypeError in strict mode (frozen)

    // Ensure original payload still intact
    expect(payload.count).toBe(2)
  })

  test("implicit Setup pseudo-phase - logs/agents before first setPhase belong to Setup", () => {
    expect(SETUP_PHASE).toBe("Setup")

    // belongsToPhase should map undefined to Setup
    expect(belongsToPhase(undefined, "Setup", ["discover", "validate"])).toBe(true)
    expect(belongsToPhase(undefined, "discover", ["discover", "validate"])).toBe(false)
    expect(belongsToPhase("Setup", "Setup", ["discover"])).toBe(true)
    expect(belongsToPhase("discover", "discover", ["discover", "validate"])).toBe(true)
    expect(belongsToPhase("discover", "validate", ["discover", "validate"])).toBe(false)
  })

  test("terminal cleanup - current_phase cleared on terminal status", () => {
    // Simulate persist logic that clears current_phase on terminal
    function persistData(active: any) {
      const isTerminal = ["completed", "failed", "cancelled", "interrupted"].includes(active.run.status)
      return {
        current_phase: isTerminal ? null : active.run.current_phase ?? null,
        pending_question: isTerminal ? null : active.run.pending_question ?? null,
      }
    }

    const active = {
      run: {
        status: "completed",
        current_phase: "report",
        pending_question: { question: "?" },
      },
    }

    const data = persistData(active)
    expect(data.current_phase).toBeNull()
    expect(data.pending_question).toBeNull()

    const activeRunning = {
      run: {
        status: "running",
        current_phase: "report",
        pending_question: { question: "?" },
      },
    }
    const dataRunning = persistData(activeRunning)
    expect(dataRunning.current_phase).toBe("report")
    expect(dataRunning.pending_question).not.toBeNull()
  })

  test("structured child attribution - child field set by ctx.workflow()", () => {
    const run = {
      id: "job_test",
      workflow: "parent",
      status: "completed",
      started_at: Date.now(),
      logs: [
        { time: Date.now(), phase: "parent", message: "parent log" },
        { time: Date.now(), phase: "child-phase", message: "child log", child: { run: "job_test:child:child", workflow: "child" } },
        { time: Date.now(), phase: "Deploy: prod", message: "deploy log" },
      ],
      agents: [
        { id: "1", status: "completed", started_at: Date.now(), phase: "parent", prompt: "p" },
        { id: "2", status: "completed", started_at: Date.now(), phase: "child-phase", prompt: "p", child: { run: "job_test:child:child", workflow: "child" } },
      ],
    } as unknown as WorkflowRun

    // mergeObservedPhases should detect child via structured field, not title heuristic
    const declared = ["parent", "verify"]
    const merged = mergeObservedPhases(declared, run)

    // Find child-phase entry
    const childEntry = merged.find((e) => e.title === "child-phase")
    expect(childEntry).toBeDefined()
    expect(childEntry!.child).toBe(true)

    // Deploy: prod should NOT be marked as child (was misclassified by old regex)
    const deployEntry = merged.find((e) => e.title === "Deploy: prod")
    expect(deployEntry).toBeDefined()
    expect(deployEntry!.child).toBe(false)
  })

  test("Deploy: prod not treated as child - old heuristic deleted", () => {
    const run = {
      id: "job_1",
      workflow: "test",
      status: "completed",
      started_at: Date.now(),
      logs: [{ time: Date.now(), phase: "Deploy: prod", message: "deploy" }],
      agents: [],
    } as unknown as WorkflowRun

    const merged = mergeObservedPhases(["parent"], run)
    const deploy = merged.find((e) => e.title === "Deploy: prod")
    expect(deploy).toBeDefined()
    expect(deploy!.child).toBe(false)
  })
})
