import { expect, test } from "bun:test"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"

test("compaction prompt preserves detailed work state and relevant files", () => {
  const prompt = SessionCompaction.buildPrompt({ context: ["conversation history"] })

  // Updated to match improved 9-section template (aligned with Claude Code)
  expect(prompt).toContain("Primary Request and Intent")
  expect(prompt).toContain("Key Technical Concepts")
  expect(prompt).toContain("Files and Code Sections")
  expect(prompt).toContain("Errors and fixes")
  expect(prompt).toContain("Current Work")
  expect(prompt).toContain("Pending Tasks")
  // Ensure full snippets emphasis preserved
  expect(prompt).toContain("full code snippets")
})

test("compaction describes tool media without embedding base64", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const serialized = SessionCompaction.serializeToolContent([
    { type: "text", text: "Image read successfully" },
    {
      type: "file",
      uri: `data:image/png;base64,${base64}`,
      mime: "image/png",
      name: "pixel.png",
    },
  ])

  expect(serialized).toBe("Image read successfully\n[Attached image/png: pixel.png]")
  expect(serialized).not.toContain(base64)
})
