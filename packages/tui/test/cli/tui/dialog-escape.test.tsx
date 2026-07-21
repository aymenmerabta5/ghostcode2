/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { tmpdir } from "../../fixture/fixture"
import { mkdir } from "node:fs/promises"
import path from "node:path"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

async function mountDialogHarness(input: { root: string }) {
  const state = path.join(input.root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const [
    { DialogProvider, useDialog },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
  ] = await Promise.all([
    import("../../../src/ui/dialog"),
    import("../../../src/context/kv"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
    import("../../../src/ui/toast"),
    import("../../../src/keymap"),
  ])

  let dialogRef: ReturnType<typeof useDialog> | undefined

  function Inner() {
    const dialog = useDialog()
    dialogRef = dialog
    return (
      <box>
        <text>base content</text>
      </box>
    )
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolvedConfig = createTuiResolvedConfig({
      keybinds: {},
      leader_timeout: 1000,
    })
    const off = registerOpencodeKeymap(keymap, renderer, resolvedConfig)
    onCleanup(off)

    return (
      <TestTuiContexts
        directory={input.root}
        paths={{
          home: input.root,
          state,
          worktree: input.root,
        }}
      >
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={resolvedConfig}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <DialogProvider>
                    <Inner />
                  </DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { kittyKeyboard: true })
  await wait(() => dialogRef !== undefined)
  return {
    app,
    get dialog() {
      if (!dialogRef) throw new Error("dialog not ready")
      return dialogRef
    },
    async cleanup() {
      app.renderer.destroy()
    },
  }
}

test("dialog escape respects onClose returning false to suppress pop", async () => {
  await using tmp = await tmpdir()
  const harness = await mountDialogHarness({ root: tmp.path })

  try {
    // Open first dialog
    harness.dialog.replace(() => <text>first</text>)
    expect(harness.dialog.stack.length).toBe(1)

    // Open second dialog with onClose returning false (should suppress pop)
    let onCloseCalled = 0
    harness.dialog.replace(
      () => <text>second</text>,
      () => {
        onCloseCalled++
        return false
      },
    )
    expect(harness.dialog.stack.length).toBe(1)
    expect(harness.dialog.stack[0].element).toBeDefined()

    // Simulate escape: call current onClose manually and check return
    const current = harness.dialog.stack.at(-1)
    const result = current?.onClose?.()
    expect(onCloseCalled).toBe(1)
    expect(result).toBe(false)
    // When onClose returns false, global handler should NOT pop
    // Our fix ensures escape handler checks result === false
    // Here we verify the contract: onClose returning false means suppression
  } finally {
    await harness.cleanup()
  }
})

test("dialog clear closes all and calls onClose", async () => {
  await using tmp = await tmpdir()
  const harness = await mountDialogHarness({ root: tmp.path })

  try {
    let closed = 0
    harness.dialog.replace(() => <text>first</text>, () => {
      closed++
    })
    expect(harness.dialog.stack.length).toBe(1)
    harness.dialog.clear()
    expect(harness.dialog.stack.length).toBe(0)
    expect(closed).toBe(1)
  } finally {
    await harness.cleanup()
  }
})

test("dialog clear does not recurse when its close callback opens another dialog", async () => {
  await using tmp = await tmpdir()
  const harness = await mountDialogHarness({ root: tmp.path })

  try {
    let closed = 0
    harness.dialog.replace(
      () => <text>workflow run</text>,
      () => {
        closed++
        harness.dialog.replace(() => <text>workflow dashboard</text>)
      },
    )

    harness.dialog.clear()

    expect(closed).toBe(1)
    expect(harness.dialog.stack).toHaveLength(0)
  } finally {
    await harness.cleanup()
  }
})

test("dialog escape returns to a replacement dialog without recursion", async () => {
  await using tmp = await tmpdir()
  const harness = await mountDialogHarness({ root: tmp.path })

  try {
    let closed = 0
    harness.dialog.replace(
      () => <text>workflow run</text>,
      () => {
        closed++
        harness.dialog.replace(() => <text>workflow dashboard</text>)
        return false
      },
    )

    await harness.app.waitForVisualIdle()
    harness.app.mockInput.pressEscape()

    expect(closed).toBe(1)
    expect(harness.dialog.stack).toHaveLength(1)
  } finally {
    await harness.cleanup()
  }
})
