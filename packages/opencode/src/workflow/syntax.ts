import ts from "typescript"

export type SyntaxErrorDetail = {
  line: number
  column: number
  message: string
  snippet: string
}

export type SyntaxResult = { ok: true } | { ok: false; errors: SyntaxErrorDetail[]; summary: string }

function extractSnippet(source: string, line: number): string {
  const lines = source.split("\n")
  const idx = line - 1
  if (idx < 0 || idx >= lines.length) return ""
  const raw = lines[idx] ?? ""
  // Strip ANSI escape sequences and control chars to prevent terminal injection,
  // then trim and limit length
  const sanitized = raw
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\x1b\].*?\x07/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
  return sanitized.trim().slice(0, 200)
}

function lineFromPos(sourceFile: ts.SourceFile, pos: number) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(pos)
  return { line: line + 1, col: character + 1 }
}

function flattenMessage(diag: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diag.messageText, "\n")
}

export function getSyntaxErrors(source: string, filePath: string): SyntaxErrorDetail[] {
  // Use createSourceFile to get parseDiagnostics (fast path)
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const diagnostics: ts.Diagnostic[] =
    (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.slice() ?? []

  // Also try transpileModule for additional diagnostics (covers some edge cases Bun would catch)
  try {
    const transpile = ts.transpileModule(source, {
      fileName: filePath,
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        allowJs: true,
        checkJs: false,
        noEmit: true,
      },
    })
    if (transpile.diagnostics) {
      for (const d of transpile.diagnostics) {
        // Avoid duplicating same start position
        if (d.start !== undefined && diagnostics.some((ex) => ex.start === d.start)) continue
        diagnostics.push(d)
      }
    }
  } catch {
    // ignore, parseDiagnostics is primary
  }

  return diagnostics.map((d) => {
    const pos = d.start !== undefined ? lineFromPos(sf, d.start) : { line: 1, col: 1 }
    const message = flattenMessage(d)
    const snippet = extractSnippet(source, pos.line)
    return { line: pos.line, column: pos.col, message, snippet }
  })
}

export function validateSyntax(source: string, filePath: string): SyntaxResult {
  const errors = getSyntaxErrors(source, filePath)
  if (errors.length === 0) return { ok: true }

  // Limit to first 5 errors for summary to keep message readable
  const shown = errors.slice(0, 5)
  const summary = shown
    .map((e) => `${filePath}:${e.line}:${e.column} - ${e.message}${e.snippet ? `\n  > ${e.snippet}` : ""}`)
    .join("\n")

  return { ok: false, errors, summary }
}

function quotePathForShell(p: string): string {
  // Use JSON.stringify for safe shell quoting (handles spaces, quotes, etc.)
  return JSON.stringify(p)
}

function redactCachePaths(msg: string): string {
  // Redact absolute temp cache file paths to avoid leaking user home/project paths
  // Covers: D:\path\.cache-xxx.ts, /path/.cache/xxx.ts, .cache-xxx.ts inside quotes
  return msg
    .replace(/["'][^"']*\.cache[^"']*\.ts["']/g, "'.cache-*.ts'")
    .replace(/[A-Za-z]:\\[^\s'"]*\.cache[^\s'"]*/g, "<redacted>/.cache-*.ts")
    .replace(/\/[^\s'"]*\.cache\/[^\s'"]*/g, "<redacted>/.cache-*.ts")
}

export function formatInvalidError(filePath: string, result: Extract<SyntaxResult, { ok: false }>): string {
  const intro = `Workflow syntax error in ${filePath}:`
  const isSynthetic = filePath.startsWith("builtin:") || filePath.startsWith("inline:") || filePath === "inline"
  const checkHint = isSynthetic
    ? ""
    : `3. Validate: bun --check ${quotePathForShell(filePath)} (must exit 0)\n`
  const cacheCleanHint = isSynthetic
    ? ""
    : `4. Clean orphan temp files: rm ${quotePathForShell(`${filePath.split(/[/\\]/).slice(0, -1).join("/")}/.cache-*`)} (or on Windows: Remove-Item -Path "${filePath
        .replace(/[/\\][^/\\]+$/, "")
        .replace(/"/g, '""')}\\.cache-*" -Force)\n`

  const hint = `
This is likely caused by an unescaped \${} inside a backtick prompt string.

Inside prompt: \`...\` every \${...} is evaluated by the workflow file at load time, NOT sent literally to the sub-agent.

- Intentional interpolation (OK): \${jsVer}, \${nodeVer}, \${finding.id} — only if variable is defined in run() scope
- Accidental (BUG): example code showing template literals for generated files must be escaped as \\\${...}

AGENT AUTO-FIX STEPS (do these in order):
1. Read the file at ${quotePathForShell(filePath)} and scan for BUG pattern inside prompt backticks:
   - Grep for: \\\${.*} where variable NOT defined in run() args/ctx scope
   - Common traps: \${v.*}, \${process.*}, \${config.*} meant as literal for generated files
   - Also: ^\${x or y} is SYNTAX ERROR (should be ^\${x} or y)
2. Fix: escape all accidental \${ as \\\${ inside prompt strings
   - BAD:  prompt: \`const x = "\${v.validation.zod}"\`  (v undefined in workflow)
   - GOOD: prompt: \`const x = "\\\${v.validation.zod}"\`  (literal sent to sub-agent)
   - BAD:  prompt: \`dep ^\${jsVer or latest}\`  ('or' invalid JS)
   - GOOD: prompt: \`dep ^\${jsVer} or latest\`
   - Prefer single quotes for generated code: 'const x = "\${y}"' avoids interpolation
${checkHint}${cacheCleanHint}5. Re-try workflow start after fixes
6. Keep workflow files < 20k lines, split large prompts into consts

If error persists after fixing \${ escapes, it may be Windows file-lock (see troubleshooting).
`

  return `${intro}\n${result.summary}${result.errors.length > 5 ? `\n... and ${result.errors.length - 5} more errors` : ""}\n${hint}`.trim()
}

export function looksLikeCacheModuleError(message: string): boolean {
  return message.includes("Cannot find module") && (message.includes(".cache-") || message.includes(".cache/") || message.includes(".cache\\"))
}

export function enhanceImportError(originalMessage: string, source: string, filePath: string): string {
  const safeOriginal = redactCachePaths(originalMessage)
  const syntaxRes = validateSyntax(source, filePath)
  if (!syntaxRes.ok) {
    return `${formatInvalidError(filePath, syntaxRes)}\n\nOriginal import error (misleading): ${safeOriginal}\n\nTip: The engine copies your workflow to a temp .cache-*.ts file and imports it via file:// URL. When that temp file has a syntax error, Bun reports "Cannot find module <cache-file>" which hides the real syntax error. The syntax errors above are the real cause — fix them and the cache error will disappear.`
  }
  // No syntax errors found, but import still failed — likely Windows race or antivirus lock
  if (looksLikeCacheModuleError(originalMessage)) {
    const dir = filePath.replace(/[/\\][^/\\]+$/, "")
    return `Failed to import workflow ${filePath}: ${safeOriginal}

This "Cannot find module .cache-*.ts" error with VALID syntax usually means:

1. WINDOWS FILE LOCK (intermittent, most common after syntax fix):
   - Antivirus / Windows Defender locked temp file right after write
   - Temp file: .cache-<uuid>.ts in same dir as workflow
   - Orphan files may linger: ${quotePathForShell(dir)}

AGENT AUTO-FIX FOR WINDOWS LOCK:
1. Clean orphan cache files:
   - Windows: Remove-Item -LiteralPath ${quotePathForShell(dir)} -Filter ".cache-*" -Force -ErrorAction SilentlyContinue
   - Unix: rm ${quotePathForShell(`${dir}/.cache-*`)} 2>/dev/null; rm -rf ${quotePathForShell(`${dir}/.opencode/workflows/.cache/*`)} 2>/dev/null
2. Re-try workflow start (engine will retry automatically once with delay)
3. If persists: add antivirus exclusion for ${quotePathForShell(dir)} or wait 2s and retry
4. Validate: bun --check ${quotePathForShell(filePath)} must exit 0

2. HIDDEN SYNTAX ERROR (if bun --check fails):
   - Run: bun --check ${quotePathForShell(filePath)}
   - Check for unescaped \${} inside backtick prompts (see formatInvalidError hint)
   - Fix: escape literal \${ as \\\${

3. STALE BUN CACHE:
   - Engine uses random temp file + file:// URL to bust cache, but try:
   - Delete: ${quotePathForShell(`${dir}/.cache-*`)}
   - Restart opencode server

Tip: After fixing, always run bun --check ${quotePathForShell(filePath)} before workflow start.
`
  }
  return `Failed to import workflow ${filePath}: ${safeOriginal}\n\nAGENT: Try cleaning .cache-* files in ${quotePathForShell(
    filePath.replace(/[/\\][^/\\]+$/, ""),
  )} and re-try. If persists, run bun --check ${quotePathForShell(filePath)}`
}

export * as Syntax from "./syntax"
