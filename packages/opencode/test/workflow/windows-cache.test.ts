import { describe, expect, test } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import fs from "fs/promises"
import os from "os"

describe("workflow Windows path and cache invalidation fix", () => {
  test("new file created via save should be importable via file:// URL (not raw Windows path)", async () => {
    const tmpdir = path.join(os.tmpdir(), `opencode-test-${Math.random().toString(36).slice(2)}`)
    await fs.mkdir(tmpdir, { recursive: true })
    
    try {
      // Simulate creating a new workflow file in .opencode/workflows/
      const workflowsDir = path.join(tmpdir, ".opencode", "workflows")
      await fs.mkdir(workflowsDir, { recursive: true })
      
      const filePath = path.join(workflowsDir, "test-new-workflow.ts")
      const content = `
export default {
  meta: { name: "test-new-workflow", description: "test", phases: ["a"] },
  async run(args, ctx) {
    return { version: 1, message: "hello from new file" }
  }
}
`
      await fs.writeFile(filePath, content, "utf-8")
      
      // This is the old buggy way: import raw Windows path (would fail in bundled context)
      // const buggyImport = await import(filePath) // This would show raw path in error
      
      // Fixed way: use pathToFileURL with file:// and forward slashes
      const fileUrl = pathToFileURL(filePath).href
      expect(fileUrl).toContain("file://")
      expect(fileUrl).not.toContain("\\") // Should have forward slashes
      expect(fileUrl).toContain("test-new-workflow.ts")
      
      // Import via file URL should work
      const mod = await import(`${fileUrl}?t=${Date.now()}`) as any
      const runFn = mod.default?.run ?? mod.run
      expect(typeof runFn).toBe("function")
      
      const result = await runFn({}, {} as any)
      expect(result.version).toBe(1)
    } finally {
      await fs.rm(tmpdir, { recursive: true, force: true }).catch(() => {})
    }
  })

  test("overwriting file should not show stale content (cache invalidation)", async () => {
    const tmpdir = path.join(os.tmpdir(), `opencode-test-${Math.random().toString(36).slice(2)}`)
    await fs.mkdir(tmpdir, { recursive: true })
    
    try {
      const workflowsDir = path.join(tmpdir, ".opencode", "workflows")
      const cacheDir = path.join(workflowsDir, ".cache")
      await fs.mkdir(cacheDir, { recursive: true })
      
      const originalPath = path.join(workflowsDir, "test-overwrite.ts")
      
      // Version 1
      const contentV1 = `
export default {
  meta: { name: "test-overwrite", description: "v1", phases: ["a"] },
  async run(args, ctx) {
    ctx?.log?.("Starting completion workflow filter=all")
    return { version: 1, prompt: "Audit repo at D:/old/single.ts stub" }
  }
}
`
      await fs.writeFile(originalPath, contentV1, "utf-8")
      
      // Simulate old buggy behavior: import original path directly with query param cache busting
      // This might still return stale due to Bun's cache ignoring query param
      // Fixed behavior: copy to random temp file and import temp file
      async function importViaTempCopy(sourcePath: string, sourceContent: string) {
        const tempPath = path.join(cacheDir, `${Date.now()}-${Math.random().toString(36).slice(2)}.ts`)
        await fs.writeFile(tempPath, sourceContent, "utf-8")
        const fileUrl = pathToFileURL(tempPath).href
        const mod = await import(`${fileUrl}?t=${Date.now()}-${Math.random().toString(36).slice(2)}`) as any
        await fs.unlink(tempPath).catch(() => {})
        return mod
      }
      
      // First import - should get v1
      const content1 = await fs.readFile(originalPath, "utf-8")
      const mod1 = await importViaTempCopy(originalPath, content1)
      const result1 = await (mod1.default?.run ?? mod1.run)({}, { log: () => {} } as any)
      expect(result1.version).toBe(1)
      expect(result1.prompt).toContain("Audit repo")
      
      // Overwrite with v2 (simulating fix-rpc-pure-orpc -> complete-flexible-billing-dual-mode.ts)
      const contentV2 = `
export default {
  meta: { name: "test-overwrite", description: "v2", phases: ["a"] },
  async run(args, ctx) {
    ctx?.log?.("Discovering RPC duality")
    return { version: 2, prompt: "Explore RPC duality" }
  }
}
`
      await fs.writeFile(originalPath, contentV2, "utf-8")
      
      // Second import via temp copy - should get v2, not stale v1
      const content2 = await fs.readFile(originalPath, "utf-8")
      const mod2 = await importViaTempCopy(originalPath, content2)
      const result2 = await (mod2.default?.run ?? mod2.run)({}, { log: (m: string) => {
        // Capture log to verify it's new content
        expect(m).not.toContain("Starting completion workflow filter=all")
      }} as any)
      
      expect(result2.version).toBe(2)
      expect(result2.prompt).toBe("Explore RPC duality")
      expect(result2.prompt).not.toContain("Audit repo")
      
      // Ensure old message not present
      expect(result2.version).not.toBe(1)
    } finally {
      await fs.rm(tmpdir, { recursive: true, force: true }).catch(() => {})
    }
  })

  test("minimal workflow export default { meta, run } should work", async () => {
    const tmpdir = path.join(os.tmpdir(), `opencode-test-${Math.random().toString(36).slice(2)}`)
    await fs.mkdir(tmpdir, { recursive: true })
    
    try {
      const filePath = path.join(tmpdir, "minimal.ts")
      const content = `export default { meta: { name:"test", phases:["a"] }, run(){ return { ok: true } } }`
      await fs.writeFile(filePath, content, "utf-8")
      
      const fileUrl = pathToFileURL(filePath).href
      const mod = await import(`${fileUrl}?t=${Date.now()}`) as any
      const runFn = mod.default?.run ?? mod.run
      expect(typeof runFn).toBe("function")
      
      const result = await runFn()
      expect(result.ok).toBe(true)
    } finally {
      await fs.rm(tmpdir, { recursive: true, force: true }).catch(() => {})
    }
  })

  test("pathToFileURL normalizes Windows backslashes to forward slashes", () => {
    // Simulate Windows path - generic example, not tied to specific project
    const winPath = "D:\\Projects\\my-app\\.opencode\\workflows\\example-workflow.ts"
    const fileUrl = pathToFileURL(winPath).href
    
    // Should be file:// URL with forward slashes, no backslashes
    expect(fileUrl.startsWith("file:///")).toBe(true)
    expect(fileUrl.includes("\\")).toBe(false)
    expect(fileUrl.includes("example-workflow.ts")).toBe(true)
    
    // On Windows, pathToFileURL should handle backslashes correctly
    // file:///D:/Projects/my-app/.opencode/workflows/example-workflow.ts
    expect(fileUrl).toContain("D:/")
  })

  test("cache directory cleanup should not affect new imports", async () => {
    const tmpdir = path.join(os.tmpdir(), `opencode-test-${Math.random().toString(36).slice(2)}`)
    const cacheDir = path.join(tmpdir, ".opencode", "workflows", ".cache")
    await fs.mkdir(cacheDir, { recursive: true })
    
    try {
      // Create some old cache files
      const oldCacheFile = path.join(cacheDir, "old-cache-123.ts")
      await fs.writeFile(oldCacheFile, "export default {}", "utf-8")
      
      // Simulate sweepOrphans deleting old files
      const files = await fs.readdir(cacheDir)
      expect(files.length).toBe(1)
      
      await fs.unlink(oldCacheFile)
      const afterDelete = await fs.readdir(cacheDir).catch(() => [] as string[])
      expect(afterDelete.length).toBe(0)
      
      // New file should still be importable after cache clear
      const newFile = path.join(tmpdir, "new.ts")
      await fs.writeFile(newFile, `export default { run() { return { fresh: true } } }`, "utf-8")
      
      const fileUrl = pathToFileURL(newFile).href
      const mod = await import(`${fileUrl}?t=${Date.now()}`) as any
      const result = await (mod.default?.run ?? mod.default)()
      expect(result.fresh).toBe(true)
    } finally {
      await fs.rm(tmpdir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
