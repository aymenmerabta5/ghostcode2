import { createEffect, createMemo, createSignal, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { useTheme } from "../../context/theme"
import { useSync } from "../../context/sync"
import { useDirectory } from "../../context/directory"
import { useConnected } from "../../component/use-connected"
import { createStore } from "solid-js/store"
import { useRoute } from "../../context/route"
import { useEvent } from "../../context/event"

export function Footer() {
  const { theme } = useTheme()
  const sync = useSync()
  const route = useRoute()
  const event = useEvent()
  const mcp = createMemo(() => Object.values(sync.data.mcp).filter((x) => x.status === "connected").length)
  const mcpError = createMemo(() => Object.values(sync.data.mcp).some((x) => x.status === "failed"))
  const lsp = createMemo(() => Object.keys(sync.data.lsp))
  const permissions = createMemo(() => {
    if (route.data.type !== "session") return []
    return sync.data.permission[route.data.sessionID] ?? []
  })
  const directory = useDirectory()
  const connected = useConnected()

  const [store, setStore] = createStore({
    welcome: false,
  })

  const [goalText, setGoalText] = createSignal<string | undefined>(undefined)
  const [goalStatus, setGoalStatus] = createSignal<string | undefined>(undefined)

  onMount(() => {
    const offGoal = event.on("goal.updated", (evt) => {
      if (route.data.type !== "session") return
      if (evt.properties.sessionID !== route.data.sessionID) return
      setGoalText(evt.properties.goal?.text)
      setGoalStatus(evt.properties.goal?.status)
    })
    onCleanup(() => offGoal())

    const timeouts: ReturnType<typeof setTimeout>[] = []
    function tick() {
      if (connected()) return
      if (!store.welcome) {
        setStore("welcome", true)
        timeouts.push(setTimeout(() => tick(), 5000))
        return
      }
      if (store.welcome) {
        setStore("welcome", false)
        timeouts.push(setTimeout(() => tick(), 10_000))
        return
      }
    }
    timeouts.push(setTimeout(() => tick(), 10_000))
    onCleanup(() => timeouts.forEach(clearTimeout))
  })

  createEffect(() => {
    if (route.data.type !== "session") {
      setGoalText(undefined)
      setGoalStatus(undefined)
      return
    }
    setGoalText(undefined)
    setGoalStatus(undefined)
  })

  return (
    <box flexDirection="row" justifyContent="space-between" gap={1} flexShrink={0}>
      <box gap={1} flexDirection="row" flexShrink={1}>
        <text fg={theme.textMuted}>{directory()}</text>
        <Show when={goalText()}>
          <text fg={goalStatus() === "completed" ? theme.success : theme.accent}>
            {"\u25CB "}{goalText()?.slice(0, 40)}{goalText()!.length > 40 ? "\u2026" : ""}
          </text>
        </Show>
      </box>
      <box gap={2} flexDirection="row" flexShrink={0}>
        <Switch>
          <Match when={store.welcome}>
            <text fg={theme.text}>
              Get started <span style={{ fg: theme.textMuted }}>/connect</span>
            </text>
          </Match>
          <Match when={connected()}>
            <Show when={permissions().length > 0}>
              <text fg={theme.warning}>
                <span style={{ fg: theme.warning }}>△</span> {permissions().length} Permission
                {permissions().length > 1 ? "s" : ""}
              </text>
            </Show>
            <text fg={theme.text}>
              <span style={{ fg: lsp().length > 0 ? theme.success : theme.textMuted }}>•</span> {lsp().length} LSP
            </text>
            <Show when={mcp()}>
              <text fg={theme.text}>
                <Switch>
                  <Match when={mcpError()}>
                    <span style={{ fg: theme.error }}>⊙ </span>
                  </Match>
                  <Match when={true}>
                    <span style={{ fg: theme.success }}>⊙ </span>
                  </Match>
                </Switch>
                {mcp()} MCP
              </text>
            </Show>
            <text fg={theme.textMuted}>/status</text>
          </Match>
        </Switch>
      </box>
    </box>
  )
}
