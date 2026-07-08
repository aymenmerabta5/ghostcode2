import { describe, expect, it } from "bun:test"
import {
  parseLoopCommandArguments,
  buildLoopPrompt,
  extractLoopControl,
  DEFAULT_LOOP_PROMPT,
} from "../../src/session/prompt"

describe("loop command parser", () => {
  describe("parseLoopCommandArguments", () => {
    it("returns stop action for 'stop'", () => {
      expect(parseLoopCommandArguments("stop")).toEqual({ action: "stop" })
    })

    it("returns stop action for 'off'", () => {
      expect(parseLoopCommandArguments("off")).toEqual({ action: "stop" })
    })

    it("returns start with empty prompt for empty input", () => {
      expect(parseLoopCommandArguments("")).toEqual({ action: "start", prompt: "" })
    })

    it("returns start with prompt for plain text", () => {
      const result = parseLoopCommandArguments("fix all type errors")
      expect(result.action).toBe("start")
      if (result.action === "start") {
        expect(result.prompt).toContain("fix all type errors")
        expect(result.prompt).toContain("Goal:")
        expect(result.intervalMs).toBeUndefined()
      }
    })

    it("parses duration prefix (5m)", () => {
      const result = parseLoopCommandArguments("5m check for new issues")
      expect(result.action).toBe("start")
      if (result.action === "start") {
        expect(result.intervalMs).toBe(5 * 60 * 1000)
        expect(result.prompt).toContain("check for new issues")
      }
    })

    it("parses duration prefix (30s)", () => {
      const result = parseLoopCommandArguments("30s quick check")
      expect(result.action).toBe("start")
      if (result.action === "start") {
        expect(result.intervalMs).toBe(30 * 1000)
      }
    })

    it("parses duration prefix (2h)", () => {
      const result = parseLoopCommandArguments("2h deep scan")
      expect(result.action).toBe("start")
      if (result.action === "start") {
        expect(result.intervalMs).toBe(2 * 60 * 60 * 1000)
      }
    })

    it("parses duration prefix (1d)", () => {
      const result = parseLoopCommandArguments("1d daily review")
      expect(result.action).toBe("start")
      if (result.action === "start") {
        expect(result.intervalMs).toBe(24 * 60 * 60 * 1000)
      }
    })

    it("returns empty prompt when only duration is given", () => {
      const result = parseLoopCommandArguments("10m")
      expect(result.action).toBe("start")
      if (result.action === "start") {
        expect(result.intervalMs).toBe(10 * 60 * 1000)
        expect(result.prompt).toBe("")
      }
    })

    it("does not parse 0s as duration", () => {
      const result = parseLoopCommandArguments("0s something")
      expect(result.action).toBe("start")
      if (result.action === "start") {
        expect(result.intervalMs).toBeUndefined()
        expect(result.prompt).toContain("0s something")
      }
    })
  })

  describe("buildLoopPrompt", () => {
    it("includes the goal text", () => {
      const prompt = buildLoopPrompt("write tests for the auth module")
      expect(prompt).toContain("write tests for the auth module")
      expect(prompt).toContain("Goal:")
    })

    it("includes loop control markers", () => {
      const prompt = buildLoopPrompt("test goal")
      expect(prompt).toContain("<loop:continue>")
      expect(prompt).toContain("<loop:stop>")
    })

    it("includes default maintenance prompt when goal is empty", () => {
      const prompt = buildLoopPrompt("")
      expect(prompt).toContain("proactive maintenance")
    })

    it("includes autonomous work instruction", () => {
      const prompt = buildLoopPrompt("some goal")
      expect(prompt).toContain("Work autonomously")
      expect(prompt).toContain("Re-check relevant state")
    })
  })

  describe("extractLoopControl", () => {
    it("extracts continue marker", () => {
      const text = `Did some work.\n${"<loop:continue>"}`
      const result = extractLoopControl(text)
      expect(result.action).toBe("continue")
      expect(result.text).toBe("Did some work.")
    })

    it("extracts stop marker", () => {
      const text = `All done.\n${"<loop:stop>"}`
      const result = extractLoopControl(text)
      expect(result.action).toBe("stop")
      expect(result.text).toBe("All done.")
    })

    it("returns stop when no marker present", () => {
      const text = "Just a regular response with no markers."
      const result = extractLoopControl(text)
      expect(result.action).toBe("stop")
      expect(result.text).toBe(text)
    })

    it("strips trailing whitespace before marker", () => {
      const text = `Working on it.   \n${"<loop:continue>"}`
      const result = extractLoopControl(text)
      expect(result.action).toBe("continue")
      expect(result.text).toBe("Working on it.")
    })
  })

  describe("DEFAULT_LOOP_PROMPT", () => {
    it("contains loop mode instruction", () => {
      expect(DEFAULT_LOOP_PROMPT).toContain("loop mode")
    })

    it("contains both control markers", () => {
      expect(DEFAULT_LOOP_PROMPT).toContain("<loop:continue>")
      expect(DEFAULT_LOOP_PROMPT).toContain("<loop:stop>")
    })
  })
})
