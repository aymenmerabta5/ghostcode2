import ts from "typescript"
import { Cause, Exit, Schema } from "effect"
import { Meta } from "@opencode-ai/schema/workflow"

const NON_LITERAL_ERROR = "workflow meta must be statically analyzable (literal values only)"

export type Result = { valid: true; meta: Meta } | { valid: false; error: string }

const decodeMeta = Schema.decodeUnknownExit(Meta)

export function read(source: string, filePath: string): Result {
  const file = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true)
  if (file.statements.filter((s) => ts.isExportAssignment(s) && !s.isExportEquals).length > 1)
    return { valid: false, error: "Multiple default exports; cannot determine the workflow" }
  const node = findMetaObject(file)
  if (!node) return { valid: false, error: "Missing meta export (export const meta / export default)" }
  const extracted = extractValue(node)
  if (extracted.ok === false) return { valid: false, error: NON_LITERAL_ERROR }
  const decoded = decodeMeta(extracted.value, { errors: "all", propertyOrder: "original" })
  if (Exit.isFailure(decoded)) return { valid: false, error: Cause.pretty(decoded.cause) }
  return { valid: true, meta: decoded.value }
}

function unwrap(node: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node))
    return unwrap(node.expression)
  return node
}

function findMetaObject(file: ts.SourceFile): ts.ObjectLiteralExpression | undefined {
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === "meta" && decl.initializer) {
          const initializer = unwrap(decl.initializer)
          return ts.isObjectLiteralExpression(initializer) ? initializer : undefined
        }
      }
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const expr = unwrap(statement.expression)
      if (ts.isObjectLiteralExpression(expr)) return metaPropertyObject(expr)
      if (ts.isCallExpression(expr)) {
        const arg = expr.arguments[0]
        const unwrapped = arg ? unwrap(arg) : undefined
        return unwrapped && ts.isObjectLiteralExpression(unwrapped) ? unwrapped : undefined
      }
    }
  }
  return undefined
}

function metaPropertyObject(object: ts.ObjectLiteralExpression): ts.ObjectLiteralExpression | undefined {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && propertyKey(property.name) === "meta") {
      const initializer = unwrap(property.initializer)
      return ts.isObjectLiteralExpression(initializer) ? initializer : undefined
    }
  }
  return undefined
}

function hasExportModifier(node: ts.HasModifiers) {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
}

function propertyKey(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return undefined
}

type Extracted = { ok: true; value: unknown } | { ok: false }
const FAIL: Extracted = { ok: false }

function isFunctionLike(node: ts.Expression) {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node)
}

function extractValue(input: ts.Expression): Extracted {
  const node = unwrap(input)
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { ok: true, value: node.text }
  if (ts.isNumericLiteral(node)) return { ok: true, value: Number(node.text) }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { ok: true, value: true }
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { ok: true, value: false }
  if (node.kind === ts.SyntaxKind.NullKeyword) return { ok: true, value: null }
  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) {
    if (node.operator === ts.SyntaxKind.MinusToken) return { ok: true, value: -Number(node.operand.text) }
    if (node.operator === ts.SyntaxKind.PlusToken) return { ok: true, value: Number(node.operand.text) }
    return FAIL
  }
  if (ts.isArrayLiteralExpression(node)) {
    const items: unknown[] = []
    for (const element of node.elements) {
      const extracted = extractValue(element)
      if (extracted.ok === false) return FAIL
      items.push(extracted.value)
    }
    return { ok: true, value: items }
  }
  if (ts.isObjectLiteralExpression(node)) {
    const result: Record<string, unknown> = {}
    for (const property of node.properties) {
      if (ts.isMethodDeclaration(property)) continue
      if (!ts.isPropertyAssignment(property)) return FAIL
      const key = propertyKey(property.name)
      if (key === undefined) return FAIL
      if (key === "run" && isFunctionLike(unwrap(property.initializer))) continue
      const extracted = extractValue(property.initializer)
      if (extracted.ok === false) return FAIL
      result[key] = extracted.value
    }
    return { ok: true, value: result }
  }
  return FAIL
}

export * as MetaReader from "./meta-reader"
