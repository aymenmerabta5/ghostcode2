import { createEffect, createMemo, createSignal, onCleanup, For, Show } from "solid-js"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"

type JobStatus = "running" | "completed" | "error" | "cancelled"

type JobInfo = {
  id: string
  type: string
  title?: string
  status: JobStatus
  started_at: number
  completed_at?: number
  output?: string
  error?: string
  metadata?: Record<string, unknown>
}

function authHeader(url: string, server: ReturnType<typeof useServer>["current"]) {
  const conn = server
  if (!conn) return {}
  const http = conn.http
  if (!http.password) return {}
  const token = authTokenFromCredentials({ username: http.username, password: http.password })
  return { Authorization: `Basic ${token}` }
}

function formatDuration(started: number, completed?: number) {
  const end = completed ?? Date.now()
  const sec = Math.round((end - started) / 1000)
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}m ${s}s`
}

export function BackgroundJobsPanel() {
  const sdk = useSDK()
  const server = useServer()
  const [jobs, setJobs] = createSignal<JobInfo[]>([])
  const [loading, setLoading] = createSignal(false)
  const [expanded, setExpanded] = createSignal<string | null>(null)

  const fetchJobs = async () => {
    try {
      const base = sdk().url.replace(/\/+$/, "")
      const dir = sdk().directory
      const headers: Record<string, string> = {
        ...(authHeader(base, server.current) as Record<string, string>),
      }
      const url = new URL(`${base}/background`)
      if (dir) url.searchParams.set("directory", dir)
      const res = await fetch(url.toString(), { headers })
      if (!res.ok) {
        // 404 means endpoint not yet available (older server) – silence
        if (res.status === 404) {
          setJobs([])
          return
        }
        throw new Error(`HTTP ${res.status}`)
      }
      const data = (await res.json()) as JobInfo[]
      setJobs(Array.isArray(data) ? data : [])
    } catch {
      // ignore polling errors
    }
  }

  const killJob = async (id: string) => {
    try {
      const base = sdk().url.replace(/\/+$/, "")
      const dir = sdk().directory
      const headers: Record<string, string> = {
        ...(authHeader(base, server.current) as Record<string, string>),
        "Content-Type": "application/json",
      }
      const url = new URL(`${base}/background/${encodeURIComponent(id)}/cancel`)
      if (dir) url.searchParams.set("directory", dir)
      setLoading(true)
      await fetch(url.toString(), { method: "POST", headers })
      await fetchJobs()
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  let timer: number | undefined

  createEffect(() => {
    // poll when SDK ready
    if (!sdk().directory) return
    void fetchJobs()
    timer = window.setInterval(() => void fetchJobs(), 2000)
    onCleanup(() => {
      if (timer !== undefined) window.clearInterval(timer)
    })
  })

  const running = createMemo(() => jobs().filter((j) => j.status === "running"))
  const recent = createMemo(() =>
    jobs()
      .filter((j) => j.status !== "running")
      .sort((a, b) => (b.completed_at ?? b.started_at) - (a.completed_at ?? a.started_at))
      .slice(0, 5),
  )

  const hasJobs = createMemo(() => jobs().length > 0)

  return (
    <Show when={hasJobs()}>
      <div class="mx-2 mb-2 rounded-[8px] border border-border-weaker-base bg-v2-background-bg-base p-2 text-12-regular">
        <div class="flex items-center justify-between px-1 py-1">
          <div class="text-12-medium">
            Background jobs ({running().length} running, {jobs().length} total)
          </div>
          <button
            class="text-11-regular text-text-weak hover:text-text-base"
            onClick={() => void fetchJobs()}
          >
            Refresh
          </button>
        </div>

        <Show when={running().length > 0}>
          <div class="flex flex-col gap-1">
            <For each={running()}>
              {(job) => (
                <div class="flex items-center justify-between rounded-[6px] bg-v2-background-bg-layer-01 px-2 py-1.5">
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                      <span class="inline-flex size-2 rounded-full bg-green-500 animate-pulse" />
                      <span class="truncate text-12-medium">{job.title ?? job.id.slice(0, 8)}</span>
                      <span class="text-11-regular text-text-weak">{job.type}</span>
                      <span class="text-11-regular text-text-faint">{formatDuration(job.started_at)}</span>
                    </div>
                    <Show when={job.output}>
                      <div class="mt-1 truncate text-11-regular text-text-weak">
                        {job.output?.slice(-120)}
                      </div>
                    </Show>
                  </div>
                  <div class="ml-2 flex items-center gap-1">
                    <ButtonV2
                      size="small"
                      variant="neutral"
                      disabled={loading()}
                      onClick={() => {
                        if (expanded() === job.id) setExpanded(null)
                        else setExpanded(job.id)
                      }}
                    >
                      {expanded() === job.id ? "Hide" : "Logs"}
                    </ButtonV2>
                    <ButtonV2 size="small" variant="destructive" disabled={loading()} onClick={() => void killJob(job.id)}>
                      Kill
                    </ButtonV2>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>

        <For each={running()}>
          {(job) => (
            <Show when={expanded() === job.id}>
              <div class="mt-1 max-h-48 overflow-auto rounded-[6px] bg-black/80 p-2 font-mono text-11-regular text-white whitespace-pre-wrap break-all">
                {job.output ?? "(no output yet)"}
                <Show when={job.error}>
                  <div class="mt-2 text-red-300">{job.error}</div>
                </Show>
              </div>
            </Show>
          )}
        </For>

        <Show when={recent().length > 0}>
          <div class="mt-2 border-t border-border-weaker-base pt-2">
            <div class="px-1 pb-1 text-11-regular text-text-weak">Recent</div>
            <For each={recent()}>
              {(job) => (
                <div class="flex items-center justify-between px-2 py-1 text-11-regular">
                  <div class="flex items-center gap-2 truncate">
                    <span
                      classList={{
                        "inline-flex size-2 rounded-full": true,
                        "bg-green-500": job.status === "completed",
                        "bg-red-500": job.status === "error",
                        "bg-zinc-400": job.status === "cancelled",
                      }}
                    />
                    <span class="truncate">{job.title ?? job.id.slice(0, 8)}</span>
                    <span class="text-text-faint">{job.status}</span>
                    <span class="text-text-faint">{formatDuration(job.started_at, job.completed_at)}</span>
                  </div>
                  <button
                    class="text-text-weak hover:text-text-base"
                    onClick={() => {
                      if (expanded() === job.id) setExpanded(null)
                      else setExpanded(job.id)
                    }}
                  >
                    {expanded() === job.id ? "Hide" : "View"}
                  </button>
                </div>
              )}
            </For>
          </div>
          <For each={recent()}>
            {(job) => (
              <Show when={expanded() === job.id}>
                <div class="mt-1 max-h-48 overflow-auto rounded-[6px] bg-black/80 p-2 font-mono text-11-regular text-white whitespace-pre-wrap break-all">
                  {job.output ?? job.error ?? "(no output)"}
                </div>
              </Show>
            )}
          </For>
        </Show>
      </div>
    </Show>
  )
}
