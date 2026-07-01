import { Config } from "effect"

export function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

function env(key: string): string | undefined {
  return process.env[`GHOSTCODE_${key}`] ?? process.env[`OPENCODE_${key}`]
}

function truthyBoth(key: string) {
  const value = env(key)?.toLowerCase()
  return value === "true" || value === "1"
}

const copy = env("EXPERIMENTAL_DISABLE_COPY_ON_SELECT")
const fff = env("DISABLE_FFF")

function enabledByExperimental(key: string) {
  return env(key) === undefined ? truthyBoth("EXPERIMENTAL") : truthyBoth(key)
}

function booleanConfig(key: string) {
  return Config.boolean(`GHOSTCODE_${key}`).pipe(
    Config.orElse(() => Config.boolean(`OPENCODE_${key}`)),
    Config.withDefault(false),
  ) as Config.Config<boolean>
}

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  OPENCODE_AUTO_HEAP_SNAPSHOT: truthyBoth("AUTO_HEAP_SNAPSHOT"),
  OPENCODE_GIT_BASH_PATH: env("GIT_BASH_PATH"),
  OPENCODE_CONFIG: env("CONFIG"),
  OPENCODE_CONFIG_CONTENT: env("CONFIG_CONTENT"),
  OPENCODE_DISABLE_AUTOUPDATE: truthyBoth("DISABLE_AUTOUPDATE"),
  OPENCODE_ALWAYS_NOTIFY_UPDATE: truthyBoth("ALWAYS_NOTIFY_UPDATE"),
  OPENCODE_DISABLE_PRUNE: truthyBoth("DISABLE_PRUNE"),
  OPENCODE_DISABLE_TERMINAL_TITLE: truthyBoth("DISABLE_TERMINAL_TITLE"),
  OPENCODE_SHOW_TTFD: truthyBoth("SHOW_TTFD"),
  OPENCODE_DISABLE_AUTOCOMPACT: truthyBoth("DISABLE_AUTOCOMPACT"),
  OPENCODE_DISABLE_MODELS_FETCH: truthyBoth("DISABLE_MODELS_FETCH"),
  OPENCODE_DISABLE_MOUSE: truthyBoth("DISABLE_MOUSE"),
  OPENCODE_FAKE_VCS: env("FAKE_VCS"),
  OPENCODE_SERVER_PASSWORD: env("SERVER_PASSWORD"),
  OPENCODE_SERVER_USERNAME: env("SERVER_USERNAME"),
  OPENCODE_DISABLE_FFF: fff === undefined ? process.platform === "win32" : truthyBoth("DISABLE_FFF"),

  // Experimental
  OPENCODE_EXPERIMENTAL_FILEWATCHER: booleanConfig("EXPERIMENTAL_FILEWATCHER"),
  OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: booleanConfig("EXPERIMENTAL_DISABLE_FILEWATCHER"),
  OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthyBoth("EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  OPENCODE_MODELS_URL: env("MODELS_URL"),
  OPENCODE_MODELS_PATH: env("MODELS_PATH"),
  OPENCODE_DB: env("DB"),

  OPENCODE_WORKSPACE_ID: env("WORKSPACE_ID"),
  OPENCODE_EXPERIMENTAL_WORKSPACES: enabledByExperimental("EXPERIMENTAL_WORKSPACES"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get OPENCODE_DISABLE_PROJECT_CONFIG() {
    return truthyBoth("DISABLE_PROJECT_CONFIG")
  },
  get OPENCODE_EXPERIMENTAL_REFERENCES() {
    return enabledByExperimental("EXPERIMENTAL_REFERENCES")
  },
  get OPENCODE_TUI_CONFIG() {
    return env("TUI_CONFIG")
  },
  get OPENCODE_CONFIG_DIR() {
    return env("CONFIG_DIR")
  },
  get OPENCODE_PURE() {
    return truthyBoth("PURE")
  },
  get OPENCODE_PERMISSION() {
    return env("PERMISSION")
  },
  get OPENCODE_PLUGIN_META_FILE() {
    return env("PLUGIN_META_FILE")
  },
  get OPENCODE_CLIENT() {
    return env("CLIENT") ?? "cli"
  },
}
