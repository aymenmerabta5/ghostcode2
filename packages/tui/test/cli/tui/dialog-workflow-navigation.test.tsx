/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

test("DialogWorkflowRun escape always goes back to dashboard (not focus toggle)", async () => {
  const filePath = path.join(import.meta.dir, "../../../src/component/dialog-workflow.tsx")
  const content = await fs.readFile(filePath, "utf8")

  // Check that escape binding in DialogWorkflowRun now calls back() directly
  // Old buggy version had: if (store.focusedPanel === "agents") focusPhases() else back()
  // New fixed version should have simple back() without focusedPanel check for escape
  const hasOldBuggyEscape = content.includes(`if (store.focusedPanel === "agents") focusPhases()`)
  // There is still a focusPhases function used for left arrow, but escape should not use it
  // Extract the escape binding section near "Back to dashboard (Esc)"
  const escapeBackSection = content.match(/key:\s*"escape"[\s\S]{0,200}Back to dashboard \(Esc\)/)
  expect(escapeBackSection).toBeDefined()

  // Ensure escape binding does NOT contain focusPhases logic anymore for that specific binding
  // We look for the escape binding in DialogWorkflowRun context
  const runSection = content.slice(content.indexOf("function DialogWorkflowRun"))
  // At least one escape should call back() and be described as back
  const hasEscapeKey = runSection.includes(`"escape"`) && runSection.includes(`Back to dashboard (Esc)`)
  const hasBackCall = runSection.includes(`back()`)
  const hasSimpleBackEscape = hasEscapeKey && hasBackCall
  expect(hasSimpleBackEscape).toBe(true)

  // Ensure old buggy pattern is not present in escape handling
  // The only remaining focusPhases usage should be in handleLeft/switchFocus, not escape
  const escapeIdx = runSection.indexOf(`Back to dashboard (Esc)`)
  const escapeBlock = runSection.slice(Math.max(0, escapeIdx - 100), escapeIdx + 500)
  expect(escapeBlock.includes("focusPhases")).toBe(false)
  // New fix also handles selection clearing – must contain clearSelection guard
  expect(escapeBlock).toContain(`getSelection`)
})

test("workflow navigation declares priority on its binding layer", async () => {
  const filePath = path.join(import.meta.dir, "../../../src/component/dialog-workflow.tsx")
  const content = await fs.readFile(filePath, "utf8")
  const runSection = content.slice(content.indexOf("function DialogWorkflowRun"))

  expect(runSection).toMatch(/useBindings\(\(\) => \(\{\s*priority: 1,\s*bindings:/)
})

test("DialogWorkflowRun has Q binding to hide workflow and reveal subagent", async () => {
  const filePath = path.join(import.meta.dir, "../../../src/component/dialog-workflow.tsx")
  const content = await fs.readFile(filePath, "utf8")

  const runSection = content.slice(content.indexOf("function DialogWorkflowRun"))
  // Check for q hide binding
  expect(runSection).toContain(`key: "q"`)
  expect(runSection).toContain(`Hide workflow to see subagent`)
  expect(runSection).toContain(`const hide = () => dialog.clear()`)
})

test("DialogWorkflowAgentDetail has Q hide binding", async () => {
  const filePath = path.join(import.meta.dir, "../../../src/component/dialog-workflow.tsx")
  const content = await fs.readFile(filePath, "utf8")

  const agentDetailSection = content.slice(content.indexOf("function DialogWorkflowAgentDetail"), content.indexOf("function DialogWorkflowRun"))
  expect(agentDetailSection).toContain(`key: "q"`)
  expect(agentDetailSection).toContain(`Hide to see subagent`)
})

test("DialogWorkflow dashboard has Q hide binding", async () => {
  const filePath = path.join(import.meta.dir, "../../../src/component/dialog-workflow.tsx")
  const content = await fs.readFile(filePath, "utf8")

  const dashboardSection = content.slice(0, content.indexOf("function DialogWorkflowSave"))
  // Dashboard should have q binding with priority and selection handling
  expect(dashboardSection).toContain(`key: "q"`)
  expect(dashboardSection).toContain(`Hide workflows to see subagent`)
  expect(dashboardSection).toContain(`priority: 1`)
  expect(dashboardSection).toContain(`getSelection`)
})

test("DialogWorkflowRun header matches keyboard navigation", async () => {
  const filePath = path.join(import.meta.dir, "../../../src/component/dialog-workflow.tsx")
  const content = await fs.readFile(filePath, "utf8")

  const runSection = content.slice(content.indexOf("function DialogWorkflowRun"))
  expect(runSection).toContain(`onMouseUp={() => back()}`)
  expect(runSection).toContain(`esc back`)
})

test("Dialog provider escape respects return false", async () => {
  const filePath = path.join(import.meta.dir, "../../../src/ui/dialog.tsx")
  const content = await fs.readFile(filePath, "utf8")

  // Closing detaches the old dialog before invoking its callback, so callbacks
  // may safely replace the dialog without recursive re-entry.
  expect(content).toContain(`function close()`)
  expect(content).toContain(`result === false`)
  expect(content).toContain(`setStore("stack", store.stack.slice(0, -1))`)
})

test("Session has escape binding to go back to parent/main agent", async () => {
  const filePath = path.join(import.meta.dir, "../../../src/routes/session/index.tsx")
  const content = await fs.readFile(filePath, "utf8")

  expect(content).toContain(`key: "escape"`)
  expect(content).toContain(`Hide workflow / Back to parent`)
  expect(content).toContain(`workflow.hide`)
  expect(content).toContain(`workflowReturnSessionID`)
  const workflowBindings = content.slice(content.indexOf("// Workflow return:"))
  // Esc must win over session.interrupt at the layer level; binding metadata
  // does not participate in keymap precedence.
  expect(workflowBindings).toMatch(/useBindings\(\(\) => \(\{\s*mode: OPENCODE_BASE_MODE,\s*priority: 2,\s*enabled:/)
  expect(content).toContain(`getSelection`)
  expect(content).toContain(`clearSelection`)
})

test("Session b binding does not intercept typing in prompt box", async () => {
  const filePath = path.join(import.meta.dir, "../../../src/routes/session/index.tsx")
  const content = await fs.readFile(filePath, "utf8")

  // b binding should guard against focused editor AND focused renderable AND prompt focused
  const mustIdx = content.indexOf("Must not intercept when an input/textarea is focused")
  expect(mustIdx).not.toBe(-1)
  const sessionSection = content.slice(mustIdx, mustIdx + 2000)
  // Accept both old style (=== null) and new style (!== null / return false) guards
  expect(sessionSection).toContain(`currentFocusedEditor`)
  expect(sessionSection).toContain(`currentFocusedRenderable`)
  // Must check prompt focused in some form
  expect(sessionSection).toMatch(/prompt.*focused/)
  // Must also guard selection so copy-on-select doesn't trigger b
  expect(sessionSection).toMatch(/getSelection|getSelectedText/)
  // Should have comment explaining guard
  expect(content).toContain(`typing "b"`)

  const workflowBindings = content.slice(content.indexOf("// Workflow return:"))
  // B is a separate, lower-priority layer that can be disabled while text input
  // owns focus, so typing b never triggers workflow navigation.
  expect(workflowBindings).toMatch(/useBindings\(\(\) => \(\{\s*mode: OPENCODE_BASE_MODE,\s*priority: 1,\s*enabled:/)
  expect(content).toContain(`workflow.return`)
  expect(content).toContain(`Back to workflow`)
})
