# Building End-to-End Features in Ghostcode

A field guide for agents who need to ship a feature across all six packages: schema, core, plugin, ghostcode, SDK, and TUI.

Built from the `/goal`, `/loop`, and `/workflows` implementation. Every pattern below was proven in that work.

---

## Architecture: The Six Packages

```
packages/
  schema/      ← Type contracts (Schema definitions, events). No runtime logic.
  core/        ← DB tables, migrations, low-level utilities. Depends on schema.
  plugin/      ← Plugin-facing types and helpers. Depends on schema.
  ghostcode/   ← The agentic engine. Services, tools, session loop, server API. Depends on all above.
  sdk/js/      ← Auto-generated client SDK. Regenerated from ghostcode's OpenAPI spec.
  tui/         ← Terminal UI. Depends on SDK only — never imports ghostcode directly.
```

### Dependency direction (strict)

```
schema  ←  core  ←  ghostcode
schema  ←  plugin
schema  ←  ghostcode
sdk/js  ←  tui
```

The TUI never imports from `ghostcode` or `core`. It talks to the server through the SDK client. The SDK is generated from the server's HttpApi declarations, so the TUI gets types for free.

---

## The Build Order

Every feature follows this order. Skip none.

1. **Schema** — define types, events
2. **Core** — DB table, migration
3. **Plugin** — plugin-facing types (if the feature exposes a plugin API)
4. **Ghostcode** — service, tool, prompt integration, command, server API
5. **SDK** — regenerate
6. **TUI** — components, wire-up, slash commands, tool displays
7. **Test** — write tests in `packages/ghostcode/test/`
8. **Typecheck** — all six packages clean

---

## 1. Schema Layer (`packages/schema/src/`)

The schema package is the single source of truth for types shared across packages. It has zero runtime dependencies.

### What goes here

- `Schema.Struct` / `Schema.Class` for data shapes
- `Schema.brand` for branded IDs
- `Schema.TaggedErrorClass` for typed errors
- Event definitions for the event manifest
- `Schema.statics(...)` for attaching metadata

### Example: Goal schema (`packages/schema/src/session-goal.ts`)

```ts
import { Schema } from "effect"

export const Info = Schema.Struct({
  text: Schema.String,
  status: Schema.Literals(["active", "paused", "completed"]),
  budget_tokens: Schema.optional(Schema.Number),
  tokens_used: Schema.Number,
  time_ms: Schema.Number,
  started_at: Schema.Number,
  paused_at: Schema.optional(Schema.Number),
  completed_at: Schema.optional(Schema.Number),
  verification: Schema.optional(Schema.String),
}).annotate({ identifier: "SessionGoal.Info" })

export const Status = Info.fields.status

export const Event = {
  Updated: Schema.Struct({
    session_id: Schema.String,
    goal: Schema.optional(Info),
  }).annotate({ identifier: "SessionGoal.Event.Updated" }),
}
```

### Example: Workflow schema (`packages/schema/src/workflow.ts`)

Workflows need branded IDs, enums, and structured events:

```ts
export const RunID = Schema.String.pipe(Schema.brand("WorkflowRunID"))
export const Status = Schema.Literals([
  "pending", "running", "paused", "completed", "failed", "cancelled", "interrupted",
])
export const Run = Schema.Struct({ ... })
export const Info = Schema.Struct({ ... })
export const Event = {
  Updated: Schema.Struct({ run: Run }).annotate({ identifier: "Workflow.Event.Updated" }),
  Finished: Schema.Struct({ run: Run }).annotate({ identifier: "Workflow.Event.Finished" }),
}
```

### Register events in the manifest

After defining events, register them in `packages/schema/src/event-manifest.ts`:

```ts
import * as SessionGoal from "./session-goal"
import * as Workflow from "./workflow"

// Inside the EventManifest definition:
SessionGoal: { Updated: SessionGoal.Event.Updated },
Workflow: { Updated: Workflow.Event.Updated, Finished: Workflow.Event.Finished },
```

### Schema conventions

- Use `snake_case` for field names to match DB columns directly
- Use `.annotate({ identifier: "..." })` on every exported schema — the SDK generator needs it
- Use `Schema.optional(...)` for nullable fields, not `Schema.UndefinedOr(...)`
- Use `Schema.Literals([...])` for string unions (not `Schema.Union` of literals)

---

## 2. Core Layer (`packages/core/src/`)

Core holds Drizzle table definitions and database migrations. It depends on schema but not on ghostcode.

### DB Tables (`packages/core/src/<domain>/sql.ts`)

Create a new file or add to an existing `sql.ts`:

```ts
// packages/core/src/session/sql.ts (GoalTable added)
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"

export const GoalTable = sqliteTable("session_goal", {
  session_id: text().primaryKey(),           // FK to session
  text: text().notNull(),
  status: text().notNull().default("active"),
  budget_tokens: integer(),                   // nullable → no .notNull()
  tokens_used: integer().notNull().default(0),
  time_ms: integer().notNull().default(0),
  started_at: integer().notNull(),
  paused_at: integer(),
  completed_at: integer(),
  verification: text(),
})
```

### Conventions

- **snake_case** field names — never camelCase. This avoids redefining column names as strings.
- Primary key goes on the natural key (e.g. `session_id` for a 1:1 relationship).
- Use `integer()` for timestamps (epoch millis), `text()` for strings/IDs.
- Nullable columns: omit `.notNull()`. Do not use `.$type<null>()`.
- Foreign keys: add `.references(() => OtherTable.id)` if you want enforcement, but ghostcode often uses logical FKs without DB enforcement.

### Migrations (`packages/core/src/database/migration/`)

Create a timestamped migration file:

```ts
// packages/core/src/database/migration/20260704171241_add_goal.ts
import type { Kysely } from "kysely"

export async function up(db: Kysely<Record<string, unknown>>): Promise<void> {
  await db.schema
    .createTable("session_goal")
    .addColumn("session_id", "text", (col) => col.primaryKey())
    .addColumn("text", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull().default("active"))
    .addColumn("budget_tokens", "integer")
    .addColumn("tokens_used", "integer", (col) => col.notNull().default(0))
    .addColumn("time_ms", "integer", (col) => col.notNull().default(0))
    .addColumn("started_at", "integer", (col) => col.notNull())
    .addColumn("paused_at", "integer")
    .addColumn("completed_at", "integer")
    .addColumn("verification", "text")
    .execute()
}

export async function down(db: Kysely<Record<string, unknown>>): Promise<void> {
  await db.schema.dropTable("session_goal").ifExists().execute()
}
```

### Make migrations idempotent

Always use `.ifNotExists()` for `createTable` and `.ifExists()` for `dropTable`:

```ts
await db.schema.createTable("session_goal").ifNotExists()...
```

### Register the migration

Two files need updating:

1. `packages/core/src/database/migration.gen.ts` — import and add to the migrations array
2. `packages/core/src/database/schema.gen.ts` — add the table to the fresh-install schema (for new databases that skip migrations)

---

## 3. Plugin Layer (`packages/plugin/src/`)

If your feature exposes an API to plugin authors (TUI plugins, external tools), define the types here. The plugin package depends on schema only.

### Example: Workflow plugin types (`packages/plugin/src/workflow.ts`)

```ts
import type { Workflow } from "@opencode-ai/schema/workflow"

export interface WorkflowContext {
  readonly prompt: (input: { sessionID: string; text: string }) => Promise<string>
  readonly question: (text: string) => Promise<string>
  readonly tool: (name: string, args: Record<string, unknown>) => Promise<unknown>
  readonly workflow: (name: string, args?: Record<string, unknown>) => Promise<string>
  readonly log: (message: string) => void
}

export interface WorkflowAgentInput {
  readonly id: number
  readonly name: string
  readonly prompt: string
  readonly model?: string
  readonly tools?: string[]
}

export function workflow(): string {
  return "workflow-helper"
}
```

### Export it from the plugin package

Add to `packages/plugin/package.json` exports:

```json
"./workflow": {
  "types": "./src/workflow.ts",
  "import": "./src/workflow.ts"
}
```

And in `packages/plugin/src/index.ts` (if it exists) or just rely on the subpath export.

### When you need plugin types

Not every feature needs plugin types. `/goal` and `/loop` don't have them — they're internal engine features. Only add plugin types if third-party code needs to interact with your feature programmatically.

---

## 4. Ghostcode Layer (`packages/ghostcode/src/`)

This is the heart of the feature. It contains the service, the model-facing tool, prompt integration, commands, and the server HTTP API. Work through these in order.

### 4a. Service (`packages/ghostcode/src/<domain>/<domain>.ts`)

Every service follows the same skeleton — the **LayerNode + self-export** pattern:

```ts
// packages/ghostcode/src/session/goal.ts
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Effect, Layer, Context } from "effect"
import { eq } from "drizzle-orm"
import { GoalTable } from "@opencode-ai/core/session/sql"
import { SessionGoal } from "@opencode-ai/schema/session-goal"

// Re-export schema types for consumers
export const Info = SessionGoal.Info
export const Status = SessionGoal.Status
export const Event = SessionGoal.Event

// Interface — the public API of the service
export interface Interface {
  readonly set: (input: { sessionID: SessionID; text: string }) => Effect.Effect<Info>
  readonly get: (sessionID: SessionID) => Effect.Effect<Info | undefined>
  readonly clear: (sessionID: SessionID) => Effect.Effect<void>
  // ...
}

// Service tag — Context.Service with branded tag
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionGoal") {}

// Layer implementation
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const { db } = yield* Database.Service

    const now = () => Date.now()

    const read = (sessionID: SessionID) =>
      db.select().from(GoalTable).where(eq(GoalTable.session_id, sessionID)).get().pipe(Effect.orDie)

    const set = Effect.fn("SessionGoal.set")(function* (input: { sessionID: SessionID; text: string }) {
      const ts = now()
      yield* db
        .insert(GoalTable)
        .values({ session_id: input.sessionID, text: input.text, status: "active", started_at: ts })
        .onConflictDoUpdate({
          target: GoalTable.session_id,
          set: { text: input.text, status: "active", started_at: ts, completed_at: null, verification: null },
        })
        .run()
      const row = yield* read(input.sessionID)
      const info = toInfo(row!)
      yield* events.emit("session.goal.updated", { session_id: input.sessionID, goal: info })
      return info
    })

    // ... other methods

    return { set, get, clear, /* ... */ }
  }),
)

// LayerNode — the standard layer wrapper for ghostcode services
export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [EventV2Bridge.node, Database.node],
})

// Self-export — the ghostcode convention
export * as Goal from "./goal"
```

### Key service conventions

1. **`Context.Service<Service, Interface>()("Tag")`** — the Effect v4 way to define a service tag.
2. **`LayerNode.make({ service, layer, deps })`** — object form, not pipe form. Lists dependencies for the layer graph.
3. **`export * as Goal from "./goal"`** — self-export at the bottom. Consumers import `{ Goal } from "@/session/goal"` and use `Goal.Service`, `Goal.node`, `Goal.Info`.
4. **`Effect.fn("Domain.method")`** — name every effect for tracing.
5. **`Effect.orDie`** on DB operations — converts defects to failures.
6. **`events.emit("event.type", data)`** — emit events through `EventV2Bridge.Service` so the TUI can listen.
7. **`onConflictDoUpdate`** — Drizzle upsert pattern for SQLite.

### 4b. Tool (`packages/ghostcode/src/tool/<name>.ts`)

Tools are what the LLM calls. They follow the `Tool.define` pattern:

```ts
// packages/ghostcode/src/tool/goal.ts
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Goal } from "../session/goal"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["update", "pause", "resume", "complete"]),
  text: Schema.optional(Schema.String),
  verification: Schema.optional(Schema.String),
})

type Metadata = { status?: string }

export const GoalTool = Tool.define<typeof Parameters, Metadata, Goal.Service>(
  "goal",                                    // tool name — must match what's in registry
  Effect.gen(function* () {
    const goals = yield* Goal.Service         // yield the service once

    return {
      description: "Manage this session's goal...",
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const updated = params.action === "complete"
            ? yield* goals.update({ sessionID: ctx.sessionID, status: "completed", verification: params.verification })
            : /* ... other actions */

          const current = updated ?? (yield* goals.get(ctx.sessionID))
          return {
            title: current ? `goal ${current.status}` : "goal",
            output: current ? JSON.stringify(current) : "no active goal",
            metadata: { status: current?.status },
          }
        }),
    }
  }),
)
```

### Register the tool

In `packages/ghostcode/src/tool/registry.ts`:

```ts
import { GoalTool } from "./goal"
import { WorkflowTool } from "./workflow"
import { Goal } from "../session/goal"
import { Workflow } from "@/workflow/workflow"

// Inside the Layer.effect gen:
const goal = yield* GoalTool
const workflow = yield* WorkflowTool

// Add to the tools list returned by the registry
```

The `Tool.define<Params, Metadata, Service>` generic takes:
1. The parameters schema type
2. The metadata type (what the tool returns to the TUI)
3. The service tag the tool depends on

### 4c. Prompt Integration (`packages/ghostcode/src/session/prompt.ts`)

If your feature injects context into the system prompt or intercepts user commands, it hooks into `prompt.ts`. This is the largest and most sensitive file in the codebase.

**Pattern: inject a block into the system prompt**

```ts
// Inside the system prompt builder
const goalBlock = yield* goal.get(sessionID)
if (goalBlock && goalBlock.status === "active") {
  sections.push({
    id: "session-goal",
    text: `<session-goal>
  Goal: ${goalBlock.text}
  Status: ${goalBlock.status}
  Budget: ${goalBlock.budget_tokens ?? "unlimited"} tokens (${goalBlock.tokens_used} used)
  Started: ${new Date(goalBlock.started_at).toISOString()}
</session-goal>`,
  })
}
```

**Pattern: handle a slash command server-side**

```ts
function handleGoalCommand(args: string, sessionID: SessionID) {
  return Effect.gen(function* () {
    const goals = yield* Goal.Service
    if (args.trim()) {
      yield* goals.set({ sessionID, text: args.trim() })
    }
    // Return the goal to the session
  })
}
```

**Pattern: system prompt ordering**

In `packages/ghostcode/src/session/llm/request.ts`, the system prompt sections are ordered. Put critical context (like goal) first:

```ts
const orderedSections = [...sections].sort((a, b) => {
  const order = ["session-goal", "instructions", "agent", /* ... */]
  return order.indexOf(a.id) - order.indexOf(b.id)
})
```

**Pattern: preserve through compaction**

In `packages/ghostcode/src/session/compaction.ts`, make sure your injected blocks survive context compaction:

```ts
const preserved = compactedSections.filter(
  (s) => s.id === "session-goal" || s.id === "system-instructions"
)
```

### 4d. Commands (`packages/ghostcode/src/command/index.ts`)

Server-side slash commands (like `/goal`, `/loop`) are defined here:

```ts
import PROMPT_GOAL from "./template/goal.txt"
import PROMPT_LOOP from "./template/loop.txt"

export const Default = {
  INIT: "init",
  GOAL: "goal",
  LOOP: "loop",
  REVIEW: "review",
} as const

// Inside the command registration:
commands[Default.GOAL] = {
  name: Default.GOAL,
  description: "set or update the session goal",
  source: "command",
  get template() { return PROMPT_GOAL },
  hints: hints(PROMPT_GOAL),
}
```

Command templates go in `packages/ghostcode/src/command/template/<name>.txt` and are imported as raw strings.

### 4e. Server HTTP API

If the TUI needs to call your feature, you need HTTP endpoints. Three files:

**File 1: API group (`packages/ghostcode/src/server/routes/instance/httpapi/groups/<name>.ts`)**

```ts
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiError } from "effect/unstable/httpapi"
import { Workflow } from "@/workflow/workflow"

const root = "/workflow"

export const WorkflowApi = HttpApi.make("workflow")
  .add(
    HttpApiGroup.make("workflow")
      .add(
        HttpApiEndpoint.get("list", root, {
          success: Schema.Array(Workflow.Info),
        }).annotateMerge({ identifier: "Workflow.list" }),
      )
      .add(
        HttpApiEndpoint.post("start", `${root}/:name/start`, {
          payload: StartPayload,
          success: Workflow.Run,
        }),
      )
      // ... more endpoints
  )
```

**File 2: Handler (`packages/ghostcode/src/server/routes/instance/httpapi/handlers/<name>.ts`)**

```ts
export const workflowHandlers = HttpApiBuilder.group(InstanceHttpApi, "workflow", (handlers) =>
  Effect.gen(function* () {
    const workflow = yield* Workflow.Service       // yield services once
    const prompt = yield* SessionPrompt.Service

    return handlers.handle("list", () => workflow.list())
      .handle("start", (ctx) => workflow.start({ name: ctx.params.name, ... }))
  }),
)
```

**File 3: Wire into the server (`packages/ghostcode/src/server/routes/instance/httpapi/`)**

In `api.ts`:
```ts
import { WorkflowApi } from "./groups/workflow"
export const InstanceHttpApi = HttpApi.make("instance")
  .addHttpApi(WorkflowApi)
  // ... other APIs
```

In `server.ts`:
```ts
import { workflowHandlers } from "./handlers/workflow"
import { Workflow } from "@/workflow/workflow"

// In the layer assembly:
Layer.provide(workflowHandlers, Workflow.node)
```

### API conventions

- Declare a `WorkflowApiError` (extends `Schema.TaggedErrorClass`) with `httpApiStatus` for endpoint-specific errors.
- Use `described(Schema.X, "description")` to annotate success schemas for OpenAPI docs.
- Yield services once at the top of the handler group, then close over them in endpoint implementations.
- Do NOT use `Effect.provide(SomeLayer)` inside request handlers — provide at the layer boundary in `server.ts`.
- Path params use `:name` syntax. Query params use `WorkspaceRoutingQuery`.
- For the SDK to generate types, every schema needs `.annotate({ identifier: "Unique.Name" })`.

---

## 5. SDK Regeneration (`packages/sdk/js/`)

After adding or changing HTTP API endpoints, regenerate the SDK so the TUI gets typed methods.

### Steps

```bash
# From packages/sdk/js
bun run build
```

This runs the build script at `packages/sdk/js/script/build.ts`, which:
1. Starts the ghostcode server temporarily
2. Fetches the OpenAPI spec
3. Generates TypeScript client code into `packages/sdk/js/src/v2/gen/`

### What gets generated

For each `HttpApiGroup`, the SDK generates:
- Types for all request/response schemas
- A client method on `sdk.client.<groupName>.<endpointName>(...)`

Example: the `workflow` group generates `sdk.client.workflow.list()`, `sdk.client.workflow.start(...)`, etc.

### Verify

After regeneration, check `packages/sdk/js/src/v2/gen/` for your new types. The TUI imports from `@opencode-ai/sdk/v2` (or similar) and gets full type safety.

### Common gotcha

The build script path in `packages/sdk/js/script/build.ts` must point to ghostcode, not opencode:
```ts
// Correct
const ghostcodePath = path.resolve(__dirname, "../../ghostcode")
```

---

## 6. TUI Layer (`packages/tui/src/`)

The TUI is a SolidJS app rendered in the terminal via OpenTUI. It communicates with the server exclusively through the SDK client. **Never import from `ghostcode` or `core`.**

### 6a. Dialog Components (`packages/tui/src/component/`)

For a major feature, create a dialog component. The pattern is a SolidJS component that uses `useSDK()` for API calls and `useDialog()` for navigation.

```tsx
// packages/tui/src/component/dialog-workflow.tsx
import { createResource, createSignal, Show, For } from "solid-js"
import { useSDK } from "../context/sdk"
import { useDialog } from "../ui/dialog"
import { useTheme } from "../context/theme"

export function DialogWorkflow(props: { openRunID?: string }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const { theme } = useTheme()

  const [runs] = createResource(() => sdk.client.workflow.runs())
  const [selectedRunID, setSelectedRunID] = createSignal(props.openRunID ?? runs()?.data?.[0]?.id)

  return (
    <box>
      <text fg={theme.accent}>Workflows</text>
      <For each={runs()?.data ?? []}>
        {(run) => (
          <text
            fg={run.id === selectedRunID() ? theme.accent : theme.text}
            onClick={() => setSelectedRunID(run.id)}
          >
            {run.name} — {run.status}
          </text>
        )}
      </For>
    </box>
  )
}
```

### Helper files

Split large dialogs into:
- `dialog-workflow.tsx` — main component
- `dialog-workflow-helpers.ts` — formatting, sorting, status icons
- `dialog-workflow-client.ts` — SDK call wrappers, event helpers
- `dialog-workflow-approval.tsx` + `dialog-workflow-approval-helpers.ts` — sub-dialogs

### 6b. Register the dialog in `app.tsx`

```tsx
import { DialogWorkflow } from "./component/dialog-workflow"

// In the appGlobalBindingCommands array (for keybinding registration):
const appGlobalBindingCommands = [
  "session.list",
  "workflow.list",    // ← add your command
] as const

// In the dialog rendering section, add a case for your command:
<Show when={dialog.current?.id === "workflow.list"}>
  <DialogWorkflow />
</Show>
```

### 6c. Slash commands in the TUI

There are **two types** of slash commands:

**Type 1: Server commands** — sent to the server via `sdk.client.session.command()`. These are defined in `packages/ghostcode/src/command/index.ts` and appear in the TUI via the sync data.

**Type 2: TUI-only commands** — intercepted in the prompt and handled locally. These open dialogs or trigger client-side actions.

To add a TUI-only command, hardcode it in `app.tsx`:

```tsx
// In app.tsx, define slash commands with slashName:
const tuiSlashCommands = [
  {
    display: "/workflows",
    description: "Open workflow dashboard",
    onSelect: () => dialog.replace(() => <DialogWorkflow />),
  },
]
```

And intercept it in the prompt (`packages/tui/src/component/prompt/index.tsx`):

```tsx
// Before the server command fallback:
if (inputText.startsWith("/workflow ") || inputText === "/workflow") {
  move.startSubmit()
  const parts = inputText.slice(1).split(/\s+/)
  const wfName = parts[1]
  // Parse args: key=value pairs
  const args = {}
  for (const arg of parts.slice(2)) {
    const eq = arg.indexOf("=")
    if (eq > 0) args[arg.slice(0, eq)] = arg.slice(eq + 1)
    else args[arg] = true
  }
  // Call SDK directly
  const result = await sdk.client.workflow.start({ name: wfName, workflowStartPayload: { args } })
  dialog.replace(() => <DialogWorkflow openRunID={result.data.id} />)
  return
}
```

#### CRITICAL: Avoid slash command duplicates

A command can exist as BOTH a server command (from `command/index.ts` via `sync.data.command`) AND a TUI app command (from `app.tsx` with `slashName`). This causes **two problems**:

1. **Duplicate autocomplete entries** — the user sees `/goal` twice in the slash menu.
2. **Arguments lost on submit** — the TUI slash interception (line ~1103 in `prompt/index.tsx`) fires BEFORE the server command path. If the TUI app command's `run()` just fills the input (e.g. `p.current.input = "/goal "`), the user's arguments are destroyed and the command is never submitted.

**Rule: If a command is a server command, do NOT give the TUI app command a `slashName`.**

```tsx
// BAD — /goal appears twice, and "/goal build feature" loses "build feature"
{
  name: "goal.set",
  slashName: "goal",      // ← creates /goal in slash menu (duplicate!)
  run: () => { p.current.input = "/goal "; dialog.clear() },
}

// GOOD — app command appears in palette only, /goal comes from server only
{
  name: "goal.set",
  // no slashName — server command handles /goal in slash menu
  run: () => { p.current.input = "/goal "; dialog.clear() },
}
```

The app command without `slashName` still appears in the command palette (by `name` and `title`), but does NOT create a slash entry. The server command is the single source of `/goal` in the slash menu.

As a safety net, the autocomplete in `autocomplete.tsx` filters out server commands whose name matches an existing TUI slash:

```tsx
const tuiSlashNames = new Set(slashes().map((s) => s.display.replace(/^\//, "")))
for (const serverCommand of sync.data.command) {
  if (serverCommand.source === "skill") continue
  if (tuiSlashNames.has(serverCommand.name)) continue  // skip duplicates
  // ...
}
```

**Only use `slashName` for TUI-only commands that have no server equivalent** (like `/workflows` which opens a dialog, or `/workflow` which calls the SDK directly).

### 6d. Tool displays (`packages/tui/src/routes/session/index.tsx`)

When the LLM calls your tool, the TUI renders an inline display. Register your tool name:

```tsx
// In the toolDisplays set:
const toolDisplays = new Set([
  "bash", "glob", "read", "grep", "write", "edit",
  "task", "todowrite", "question", "skill",
  "workflow",   // ← add your tool
])

// Then add a Match case in the tool renderer:
<Match when={display() === "workflow"}>
  <WorkflowCall {...toolprops} />
</Match>

// Define the component:
function WorkflowCall(props: ToolProps) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const meta = createMemo(() => workflowMetadata(props.metadata))

  return (
    <InlineTool
      icon={meta().status === "completed" ? "✓" : "○"}
      iconColor={meta().status === "completed" ? theme.success : theme.warning}
      pending={`Running ${meta().workflow ?? "workflow"}...`}
      complete={meta().status !== "running"}
      part={props.part}
      onClick={() => meta().runId && dialog.replace(() => <DialogWorkflow openRunID={meta().runId} />)}
    >
      <text fg={theme.accent}>{meta().workflow ?? "workflow"}</text>
    </InlineTool>
  )
}
```

### 6e. Autocomplete (`packages/tui/src/component/prompt/`)

If your feature has names the user can type (like workflow names), add autocomplete:

```ts
// packages/tui/src/component/prompt/workflow-autocomplete.ts
export async function listWorkflowInfos(workflow: WorkflowClient, enabled: boolean) {
  if (!enabled) return []
  const result = await workflow.list()
  return result.data.filter((w) => w.valid !== false)
}

export function workflowNameOptions(input, workflows) {
  return workflows.map((w) => ({
    display: w.name,
    value: w.name,
    description: w.meta.description ?? w.meta.name,
  }))
}
```

Wire it into `autocomplete.tsx`:

```tsx
const [workflowInfos] = createResource(async () => {
  return await listWorkflowInfos(sdk.client.workflow, true)
})

// In the autocomplete suggestions:
for (const info of workflowInfos() ?? []) {
  suggestions.push({ display: `/${info.name}`, description: info.meta.description })
}
```

### 6f. Keybindings (`packages/tui/src/config/keybind.ts`)

```ts
// Add a keybinding for your command:
export const defaultKeybinds = {
  // ...
  "session.workflow.open": { keys: ["leader", "w"] },
}
```

### 6g. Route context (`packages/tui/src/context/route.tsx`)

If your feature needs to track state on the session route (like a selected run ID):

```tsx
export type SessionRoute = {
  sessionID: string
  // ... existing fields
  workflowRunID?: string
  workflowPhase?: string
  workflowReturnSessionID?: string
}
```

### 6h. Notifications (`packages/tui/src/feature-plugins/system/notifications.ts`)

Register a notification for your feature's completion event:

```ts
// Listen for workflow.run.finished
if (event.type === "workflow.run.finished") {
  showNotification(`Workflow ${event.properties.run.name} finished`)
}
```

### 6i. Permission display (`packages/tui/src/routes/session/permission.tsx`)

If your tool requires permission, add a display case:

```tsx
<Match when={permission.tool === "workflow"}>
  <text>Run workflow: {permission.input.name}</text>
</Match>
```

---

## 7. Testing (`packages/ghostcode/test/`)

Tests run from the package directory, never from repo root (guard: `do-not-run-tests-from-root`).

### Structure

```
packages/ghostcode/test/
  session/
    goal.test.ts      ← 7 tests
    loop.test.ts      ← 20 tests
  workflow/
    workflow.test.ts  ← 26 tests
```

### Test pattern

```ts
import { describe, it, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Goal } from "@/session/goal"

describe("Goal", () => {
  it("set creates a goal", () => {
    const program = Effect.gen(function* () {
      const goals = yield* Goal.Service
      const info = yield* goals.set({ sessionID: "s1", text: "build feature" })
      return info
    })
    const result = await Effect.runPromise(
      program.pipe(Effect.provide(testLayer))
    )
    expect(result.text).toBe("build feature")
    expect(result.status).toBe("active")
  })
})
```

### Test conventions

- **No mocks.** Test actual implementations. Use an in-memory database or temp directory.
- **Don't duplicate logic.** Assert behavior, not implementation details.
- Use `Effect.runPromise` to execute effectful tests.
- Provide test layers with `Effect.provide(testLayer)`.

### Run tests

```bash
# From packages/ghostcode
bun test test/session/goal.test.ts
bun test test/workflow/
```

---

## 8. Typechecking

Always run `bun typecheck` from the package directories, never `tsc` directly.

```bash
cd packages/schema     && bun typecheck
cd packages/core       && bun typecheck
cd packages/plugin     && bun typecheck
cd packages/ghostcode  && bun typecheck
cd packages/sdk/js     && bun typecheck
cd packages/tui        && bun typecheck
```

The command is `tsgo --noEmit` under the hood. Fix all errors before claiming done.

---

## 9. Effect v4 Beta Gotchas

Ghostcode uses `effect@4.0.0-beta.83`. Several familiar APIs don't exist or work differently.

### APIs that DON'T exist

```ts
// ❌ Does not exist — use Effect.result
Effect.either(effect)

// ❌ Does not exist — use Effect.result + Exit matching
Effect.catchAll(effect, handler)

// ❌ Does not exist — use Effect.forkIn(scope)
Effect.fork(effect)
Effect.forkDaemon(effect)
```

### Correct patterns

```ts
// ✅ Effect.result returns Exit with .success / .failure
const result = yield* Effect.result(someEffect)
if (result._tag === "Success") {
  // result.success
} else {
  // result.failure
}

// ✅ Semaphore.take is module-level, returns Effect<number>
yield* Semaphore.take(semaphore, 1)

// ✅ Fork into a scope
yield* Effect.forkIn(scope)(someEffect)

// ✅ Effect.void instead of Effect.succeed(undefined)
yield* Effect.void
```

### Service definition

```ts
// ✅ Effect v4 service tag
export class Service extends Context.Service<Service, Interface>()("@opencode/MyFeature") {}
```

### LayerNode

```ts
// ✅ Object form, not pipe form
export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Database.node, EventV2Bridge.node],
})
```

### InstanceState

```ts
// ✅ Takes a function that receives ctx
const state = yield* InstanceState.make<State>((ctx) =>
  Effect.gen(function* () {
    // ctx.directory, ctx.worktree available
    return { /* ... */ }
  }),
)
```

### Schema functions

```ts
// ✅ Schema.statics (not Schema.withStatics)
const MySchema = Schema.Struct({ ... }).pipe(Schema.statics({ ... }))
```

---

## 10. Self-Export Pattern

Every ghostcode module ends with a self-export. This is mandatory.

```ts
// src/foo/foo.ts
export interface Interface { ... }
export class Service extends Context.Service<Service, Interface>()("@opencode/Foo") {}
export const node = LayerNode.make({ service: Service, layer, deps: [...] })

// Self-export at the bottom
export * as Foo from "./foo"
```

Consumers:
```ts
import { Foo } from "@/foo/foo"
yield* Foo.Service
Foo.node
Foo.Info
```

For `index.ts` files (single-namespace directory):
```ts
export * as Foo from "."
```

For multi-sibling directories (like `src/session/`), don't add a barrel `index.ts`. Each sibling self-exports:
```ts
import { SessionRetry } from "@/session/retry"
import { SessionStatus } from "@/session/status"
```

---

## 11. End-to-End Checklist

Use this as a pre-flight checklist for every feature.

### Schema
- [ ] Created `packages/schema/src/<feature>.ts` with `Schema.Struct` / `Schema.brand`
- [ ] Every schema annotated with `.annotate({ identifier: "Feature.Name" })`
- [ ] Events defined and registered in `packages/schema/src/event-manifest.ts`

### Core
- [ ] DB table in `packages/core/src/<domain>/sql.ts` with snake_case fields
- [ ] Migration in `packages/core/src/database/migration/<timestamp>_<name>.ts` (idempotent with `.ifNotExists()`)
- [ ] Migration registered in `migration.gen.ts`
- [ ] Table added to `schema.gen.ts` (fresh-install path)

### Plugin (if needed)
- [ ] Types in `packages/plugin/src/<feature>.ts`
- [ ] Export added to `packages/plugin/package.json`

### Ghostcode
- [ ] Service in `packages/ghostcode/src/<domain>/<domain>.ts` with Interface, Service tag, layer, LayerNode, self-export
- [ ] Tool in `packages/ghostcode/src/tool/<name>.ts` using `Tool.define<Params, Metadata, Service>`
- [ ] Tool registered in `packages/ghostcode/src/tool/registry.ts`
- [ ] Prompt integration in `packages/ghostcode/src/session/prompt.ts` (if applicable)
- [ ] System prompt ordering in `packages/ghostcode/src/session/llm/request.ts` (if applicable)
- [ ] Compaction preservation in `packages/ghostcode/src/session/compaction.ts` (if applicable)
- [ ] Command in `packages/ghostcode/src/command/index.ts` with template (if applicable)
- [ ] HTTP API group in `packages/ghostcode/src/server/routes/instance/httpapi/groups/<name>.ts`
- [ ] HTTP handler in `packages/ghostcode/src/server/routes/instance/httpapi/handlers/<name>.ts`
- [ ] API registered in `packages/ghostcode/src/server/routes/instance/httpapi/api.ts`
- [ ] Handler + service node wired in `packages/ghostcode/src/server/routes/instance/httpapi/server.ts`

### SDK
- [ ] `bun run build` from `packages/sdk/js`
- [ ] Verified generated types exist in `packages/sdk/js/src/v2/gen/`

### TUI
- [ ] Dialog component(s) in `packages/tui/src/component/dialog-<feature>.tsx`
- [ ] Helper files split out (helpers, client, sub-dialogs)
- [ ] Dialog imported and rendered in `packages/tui/src/app.tsx`
- [ ] Command added to `appGlobalBindingCommands` (if keybound)
- [ ] Slash command hardcoded in `app.tsx` or intercepted in `prompt/index.tsx`
- [ ] **No duplicate slash commands** — if command is server-side, do NOT add `slashName` to the TUI app command
- [ ] Tool display registered in `toolDisplays` set in `routes/session/index.tsx`
- [ ] Tool display component (`<Feature>Call`) defined in `routes/session/index.tsx`
- [ ] Autocomplete wired in `component/prompt/autocomplete.tsx` (if applicable)
- [ ] Keybinding in `packages/tui/src/config/keybind.ts` (if applicable)
- [ ] Route fields in `packages/tui/src/context/route.tsx` (if applicable)
- [ ] Notification in `packages/tui/src/feature-plugins/system/notifications.ts` (if applicable)
- [ ] Permission display in `packages/tui/src/routes/session/permission.tsx` (if applicable)

### Test & Verify
- [ ] Tests written in `packages/ghostcode/test/<domain>/`
- [ ] `bun test` passes from `packages/ghostcode`
- [ ] `bun typecheck` clean for all six packages

---

## 12. Key Lessons from Building /goal, /loop, /workflows

### Circular dependencies are real

The workflow tool cannot import `SessionPrompt.prompt` directly — it would create a circular dependency (`prompt.ts` → `ToolRegistry` → `WorkflowTool` → `prompt.ts`). Solution: the HTTP handler imports both `Workflow.Service` and `SessionPrompt.Service` and passes `prompt` as a callback to `workflow.start()`.

### Don't break the rotation

Ghostcode's session loop and Anthropic API integration are battle-tested. When modifying `prompt.ts`, touch only the sections you need. Never refactor the core `loop()` function or the provider call path.

### Write the engine chunk by chunk

Large files like `workflow.ts` (~817 lines) were built incrementally — schema imports, service tag, layer, then methods one at a time. Don't write the whole file at once; build it up and typecheck after each addition.

### Send a reviewer agent after each feature

After completing a feature, dispatch a subagent to review the implementation against the original PR diff. The reviewer catches:
- Missing wire-up (autocomplete not connected, dead signals)
- P0 issues (initial state not loaded, events not emitted)
- Pattern violations (wrong service definition, missing self-export)

### TUI slash command flow

```
User types /workflow research
         ↓
prompt/index.tsx intercepts (before server fallback)
         ↓
Parses name + args
         ↓
sdk.client.workflow.start({ name, workflowStartPayload: { args } })
         ↓
dialog.replace(() => <DialogWorkflow openRunID={result.data.id} />)
```

```
User types /goal build the feature
         ↓
Not intercepted by TUI (it's a server command)
         ↓
sdk.client.session.command({ command: "goal", arguments: "build the feature" })
         ↓
Server runs handleGoalCommand → Goal.Service.set()
         ↓
Goal injected into system prompt on next turn
```

### Event flow (server → TUI)

```
Server: events.emit("session.goal.updated", { session_id, goal })
         ↓
EventV2Bridge broadcasts to SSE stream
         ↓
TUI: useEvent() hook receives event
         ↓
Footer component updates goal indicator
```

### Dialog navigation

```tsx
// Open a dialog (replaces current)
dialog.replace(() => <DialogWorkflow />)

// Open with context
dialog.replace(() => <DialogWorkflow openRunID="abc123" />)

// Fullscreen dialog (added for workflow dashboard)
dialog.replace(() => <DialogWorkflow />, { size: "fullscreen" })
```

### Metadata is the bridge between tool and TUI

The tool's `metadata` return value is what the TUI uses to render inline displays. Design it carefully:

```ts
// Tool returns:
return {
  title: "workflow started",
  output: "Run ID: abc123",
  metadata: {
    runID: "abc123",        // TUI uses this to open dashboard
    workflow: "research",   // TUI shows this as label
    status: "running",      // TUI shows correct icon
  },
}
```

The TUI reads `metadata` in the `WorkflowCall` component and decides icon, color, and click behavior.

---

## 13. File Map: Where Things Live

| Concern | Location |
|---------|----------|
| Schema types | `packages/schema/src/<feature>.ts` |
| Event manifest | `packages/schema/src/event-manifest.ts` |
| DB tables | `packages/core/src/<domain>/sql.ts` |
| Migrations | `packages/core/src/database/migration/` |
| Migration registry | `packages/core/src/database/migration.gen.ts` |
| Fresh schema | `packages/core/src/database/schema.gen.ts` |
| Plugin types | `packages/plugin/src/<feature>.ts` |
| Service | `packages/ghostcode/src/<domain>/<domain>.ts` |
| Tool | `packages/ghostcode/src/tool/<name>.ts` |
| Tool registry | `packages/ghostcode/src/tool/registry.ts` |
| Prompt logic | `packages/ghostcode/src/session/prompt.ts` |
| System prompt builder | `packages/ghostcode/src/session/llm/request.ts` |
| Compaction | `packages/ghostcode/src/session/compaction.ts` |
| Commands | `packages/ghostcode/src/command/index.ts` |
| Command templates | `packages/ghostcode/src/command/template/<name>.txt` |
| HTTP API groups | `packages/ghostcode/src/server/routes/instance/httpapi/groups/` |
| HTTP handlers | `packages/ghostcode/src/server/routes/instance/httpapi/handlers/` |
| API registration | `packages/ghostcode/src/server/routes/instance/httpapi/api.ts` |
| Server assembly | `packages/ghostcode/src/server/routes/instance/httpapi/server.ts` |
| SDK build script | `packages/sdk/js/script/build.ts` |
| SDK generated | `packages/sdk/js/src/v2/gen/` |
| TUI dialogs | `packages/tui/src/component/dialog-<feature>.tsx` |
| TUI app entry | `packages/tui/src/app.tsx` |
| TUI prompt | `packages/tui/src/component/prompt/index.tsx` |
| TUI autocomplete | `packages/tui/src/component/prompt/autocomplete.tsx` |
| TUI session route | `packages/tui/src/routes/session/index.tsx` |
| TUI keybindings | `packages/tui/src/config/keybind.ts` |
| TUI route context | `packages/tui/src/context/route.tsx` |
| TUI notifications | `packages/tui/src/feature-plugins/system/notifications.ts` |
| TUI permissions | `packages/tui/src/routes/session/permission.tsx` |
| Tests | `packages/ghostcode/test/<domain>/` |

---

## 14. Quick Reference: The Service Skeleton

Copy-paste this for every new service:

```ts
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { Effect, Layer, Context } from "effect"
import { /* SchemaTypes */ } from "@opencode-ai/schema/<feature>"

export const Info = /* re-export from schema */
export const Event = /* re-export from schema */

export interface Interface {
  readonly method: (input: Input) => Effect.Effect<Output>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Feature") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const { db } = yield* Database.Service

    const method = Effect.fn("Feature.method")(function* (input: Input) {
      // implementation
      return result
    })

    return { method }
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [EventV2Bridge.node, Database.node],
})

export * as Feature from "./feature"
```

---

*This guide was written after implementing `/goal` (7 tests), `/loop` (20 tests), and `/workflows` (26 tests) end-to-end across all six packages. 53 tests passing, all packages typecheck clean.*
