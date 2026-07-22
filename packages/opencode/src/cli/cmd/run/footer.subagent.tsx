/** @jsxImportSource @opentui/solid */
import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { registerOpencodeSpinner } from "@opencode-ai/tui/component/register-spinner"
import { Show, createMemo, indexArray } from "solid-js"
import { SPINNER_FRAMES } from "@opencode-ai/tui/component/spinner"
import { RunEntryContent, separatorRows } from "./scrollback.writer"
import type { FooterSubagentDetail, FooterSubagentTab, RunDiffStyle } from "./types"
import type { RunFooterTheme, RunTheme } from "./theme"

registerOpencodeSpinner()

export const SUBAGENT_INSPECTOR_ROWS = 14

function statusColor(theme: RunFooterTheme, status: FooterSubagentTab["status"]) {
  if (status === "completed") {
    return theme.highlight
  }

  if (status === "cancelled") {
    return theme.muted
  }

  if (status === "error") {
    return theme.error
  }

  return theme.highlight
}

function statusIcon(status: FooterSubagentTab["status"]) {
  if (status === "completed") {
    return "●"
  }

  if (status === "cancelled") {
    return "○"
  }

  if (status === "error") {
    return "◍"
  }

  return "◔"
}

function typeIconForTab(tab: FooterSubagentTab | undefined) {
  if (!tab) return "●"
  if (tab.label === "Shell") return "▣"
  // background shell jobs have partID starting with background: and label Shell
  if (tab.partID?.startsWith("background:") && tab.label.toLowerCase().includes("shell")) return "▣"
  // heuristics for shell command in description
  const desc = (tab.description ?? "").toLowerCase()
  if (desc.startsWith("bun ") || desc.startsWith("npm ") || desc.startsWith("yarn ") || desc.includes(" run dev")) return "▣"
  return "🤖"
}

function isBackgroundTab(tab: FooterSubagentTab | undefined) {
  if (!tab) return false
  return tab.background === true || tab.partID?.startsWith("background:") === true
}

export function RunFooterSubagentBody(props: {
  active: () => boolean
  theme: () => RunTheme
  tab: () => FooterSubagentTab | undefined
  index: () => number
  total: () => number
  detail: () => FooterSubagentDetail | undefined
  width: () => number
  diffStyle?: RunDiffStyle
  onCycle: (dir: -1 | 1) => void
  onClose: () => void
  onInterrupt?: () => boolean
}) {
  const theme = createMemo(() => props.theme())
  const footer = createMemo(() => theme().footer)
  const tab = createMemo(() => props.tab())
  const commits = createMemo(() => props.detail()?.commits ?? [])
  const opts = createMemo(() => ({ diffStyle: props.diffStyle }))
  const scrollbar = createMemo(() => ({
    trackOptions: {
      backgroundColor: footer().surface,
      foregroundColor: footer().line,
    },
  }))
  const title = createMemo(() => {
    const current = tab()
    if (!current) {
      return ""
    }

    return current.description || current.title || current.label
  })
  const subtitle = createMemo(() => {
    const current = tab()
    if (!current || title() === current.label) {
      return ""
    }

    return current.label
  })
  const rows = indexArray(commits, (commit, index) => (
    <box flexDirection="column" gap={0} flexShrink={0}>
      {index > 0 && separatorRows(commits()[index - 1], commit()) > 0 ? <box height={1} flexShrink={0} /> : null}
      <RunEntryContent commit={commit()} theme={theme()} opts={opts()} width={props.width()} />
    </box>
  ))
  let scroll: ScrollBoxRenderable | undefined

  useKeyboard((event) => {
    if (!props.active()) {
      return
    }

    if (event.name === "escape") {
      event.preventDefault()
      // If interrupt handler exists, use it (kills subagent with double-press guard)
      // Otherwise fallback to just closing inspector
      if (props.onInterrupt) {
        if (props.onInterrupt()) {
          return
        }
      }
      props.onClose()
      return
    }

    if (event.name === "tab" && !event.shift) {
      event.preventDefault()
      props.onCycle(1)
      return
    }

    if (event.name === "up" || event.name === "k") {
      event.preventDefault()
      scroll?.scrollBy(-1)
      return
    }

    if (event.name === "down" || event.name === "j") {
      event.preventDefault()
      scroll?.scrollBy(1)
    }
  })

  const isShell = createMemo(() => {
    const t = tab()
    if (!t) return false
    return t.label === "Shell"
  })
  const isBackground = createMemo(() => isBackgroundTab(tab()))
  const typeIcon = createMemo(() => typeIconForTab(tab()))
  const bannerAgent = createMemo(() => {
    const t = tab()
    if (!t) return ""
    return t.label.toLowerCase()
  })
  const bannerPos = createMemo(() => {
    const tot = props.total()
    const idx = props.index()
    if (tot > 1 && idx > 0) return `(${idx}/${tot})`
    return ""
  })
  const bannerDuration = createMemo(() => {
    const t = tab()
    if (!t) return ""
    if (t.status !== "running") return ""
    const elapsed = Math.max(0, Math.floor((Date.now() - t.lastUpdatedAt) / 1000))
    if (elapsed < 60) return `${elapsed}s`
    const m = Math.floor(elapsed / 60)
    const s = elapsed % 60
    return `${m}m${s}s`
  })

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={footer().surface}>
      {/* Banner when messaging subagent - shows agent, index/total, type icon, status */}
      <Show when={tab()}>
        <box
          width="100%"
          flexDirection="row"
          gap={1}
          paddingLeft={1}
          paddingRight={1}
          flexShrink={0}
          backgroundColor={footer().status}
        >
          <text fg={footer().highlight} wrapMode="none" truncate flexShrink={0}>
            Messaging:
          </text>
          <text fg={footer().text} wrapMode="none" truncate flexGrow={1} flexShrink={1}>
            @{bannerAgent()} subagent {bannerPos()}{" "}
            <span style={{ fg: footer().muted }}>
              [{typeIcon()} {title() || subtitle() || bannerAgent()} {tab()!.status}
              {bannerDuration() ? " " + bannerDuration() : ""}]
            </span>{" "}
            <span style={{ fg: footer().muted }}>— ESC=kill subagent, return to main</span>
          </text>
        </box>
      </Show>

      <box paddingTop={1} paddingLeft={1} paddingRight={3} paddingBottom={1} flexDirection="column" flexGrow={1}>
        <Show when={tab()}>
          {(current) => (
            <box width="100%" flexDirection="row" gap={1} paddingBottom={1} flexShrink={0}>
              {current().status === "running" ? (
                <box flexShrink={0}>
                  <spinner frames={SPINNER_FRAMES} interval={80} color={statusColor(footer(), current().status)} />
                </box>
              ) : (
                <text fg={statusColor(footer(), current().status)} wrapMode="none" truncate flexShrink={0}>
                  {statusIcon(current().status)}
                </text>
              )}
              <text fg={footer().text} wrapMode="none" truncate flexGrow={1} flexShrink={1}>
                {title()}
                <Show when={subtitle().length > 0}>
                  <span style={{ fg: footer().muted }}>{"  " + subtitle()}</span>
                </Show>
                <Show when={isBackground()}>
                  <span style={{ fg: footer().muted }}>{"  " + typeIcon() + " background"}</span>
                </Show>
              </text>
              <Show when={props.total() > 1 && props.index() > 0}>
                <text fg={footer().muted} wrapMode="none" truncate flexShrink={0}>
                  {props.index()} of {props.total()}
                </text>
              </Show>
            </box>
          )}
        </Show>

        {/* Background job details: show command/output when selected is shell job */}
        <Show when={isBackground() && commits().length === 0}>
          <box width="100%" flexDirection="column" gap={1} flexShrink={0} paddingBottom={1}>
            <Show when={tab()}>
              {(t) => (
                <>
                  <box flexDirection="row" gap={1}>
                    <text fg={footer().muted} wrapMode="none">command:</text>
                    <text fg={footer().text} wrapMode="word" flexGrow={1}>
                      {t().description || t().title || t().label}
                    </text>
                  </box>
                  <box flexDirection="row" gap={1}>
                    <text fg={footer().muted} wrapMode="none">status:</text>
                    <text fg={statusColor(footer(), t().status)} wrapMode="none">
                      {t().status} {typeIcon()} {isShell() ? "shell" : "task"}
                    </text>
                  </box>
                </>
              )}
            </Show>
          </box>
        </Show>

        <scrollbox
          width="100%"
          height="100%"
          stickyScroll={true}
          stickyStart="bottom"
          verticalScrollbarOptions={scrollbar()}
          ref={(item) => {
            scroll = item
          }}
        >
          <box width="100%" flexDirection="column" gap={0}>
            <Show
              when={commits().length > 0}
              fallback={
                <Show
                  when={!isBackground()}
                  fallback={
                    <text fg={footer().muted} wrapMode="word">
                      {isShell() ? "No output yet — waiting for background shell..." : "Background job queued"}
                    </text>
                  }
                >
                  <text fg={footer().muted} wrapMode="word">
                    No subagent activity yet
                  </text>
                </Show>
              }
            >
              {rows()}
            </Show>
          </box>
        </scrollbox>
      </box>
    </box>
  )
}
