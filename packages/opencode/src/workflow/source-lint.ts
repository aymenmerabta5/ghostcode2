import ts from "typescript"

export type Finding = { line: number; rule: string; text: string }

const FLAGGED_BUILTINS = new Set([
  "fs",
  "child_process",
  "net",
  "http",
  "https",
  "dns",
  "os",
  "worker_threads",
  "vm",
])

const FLAGGED_BUN_MEMBERS = new Set(["spawn", "spawnSync", "write", "file", "$"])

function moduleRoot(specifier: string): string {
  const stripped = specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier
  const slash = stripped.indexOf("/")
  return slash === -1 ? stripped : stripped.slice(0, slash)
}

function isFlaggedModule(specifier: string): boolean {
  return FLAGGED_BUILTINS.has(moduleRoot(specifier))
}

function snippet(node: ts.Node, file: ts.SourceFile): string {
  const text = node.getText(file).replace(/\s+/g, " ").trim()
  return text.length > 120 ? text.slice(0, 117) + "..." : text
}

export function lint(source: string, filePath: string): { findings: Finding[] } {
  const file = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true)
  const findings: Finding[] = []
  const add = (node: ts.Node, rule: string) => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
    findings.push({ line: line + 1, rule, text: snippet(node, file) })
  }

  // Escape hatch for determinism: if meta.allowNondeterminism: true, skip determinism checks
  const allowNondeterminism = /allowNondeterminism\s*:\s*true/.test(source)

  const visit = (node: ts.Node): void => {
    // Determinism lint per locked decision #4: BLOCKING error for Date.now(), Math.random(), no-arg new Date()
    if (!allowNondeterminism) {
      if (ts.isCallExpression(node)) {
        // Date.now()
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "Date" &&
          node.expression.name.text === "now"
        ) {
          add(node, "determinism-date-now")
        }
        // Math.random()
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "Math" &&
          node.expression.name.text === "random"
        ) {
          add(node, "determinism-math-random")
        }
      }
      if (ts.isNewExpression(node)) {
        if (ts.isIdentifier(node.expression) && node.expression.text === "Date") {
          if (!node.arguments || node.arguments.length === 0) {
            add(node, "determinism-new-date")
          }
        }
      }
    }

    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      isFlaggedModule(node.moduleSpecifier.text)
    ) {
      add(node, "node-builtin-import")
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression) &&
      isFlaggedModule(node.moduleReference.expression.text)
    ) {
      add(node, "node-builtin-require")
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0]
        if (arg !== undefined && ts.isStringLiteral(arg)) {
          if (isFlaggedModule(arg.text)) add(node, "node-builtin-import")
        } else {
          add(node, "dynamic-import")
        }
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        const arg = node.arguments[0]
        if (arg !== undefined && ts.isStringLiteral(arg)) {
          if (isFlaggedModule(arg.text)) add(node, "node-builtin-require")
        } else {
          add(node, "node-builtin-require")
        }
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === "fetch") {
        add(node, "fetch")
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Bun" &&
      FLAGGED_BUN_MEMBERS.has(node.name.text)
    ) {
      add(node, "bun-api")
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "process" &&
      node.name.text === "env"
    ) {
      add(node, "process-env")
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return { findings }
}

export * as SourceLint from "./source-lint"
