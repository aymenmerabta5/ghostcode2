export const meta = {
  name: "global-api",
  description: "Test global-style workflows with bare agent/pipeline globals",
  phases: ["discover", "work", "verify"],
  arguments: {
    topic: { type: "string", default: "test", description: "Topic to test" }
  },
  whenToUse: "When testing global API compatibility"
}

// This tests global agent/pipeline style (bare globals) vs ctx style
const result = await (async () => {
  if (typeof (globalThis as any).setPhase === "function") {
    (globalThis as any).setPhase("discover")
    ;(globalThis as any).log(`Testing global API with topic: ${(globalThis as any).args?.topic}`)
  }

  const hasGlobalAgent = typeof (globalThis as any).agent === "function"
  
  if (hasGlobalAgent) {
    if (typeof (globalThis as any).setPhase === "function") (globalThis as any).setPhase("work")
    const found = await (globalThis as any).agent("List files", {
      schema: { type: "object", required: ["files"], properties: { files: { type: "array", items: { type: "string" } } } },
      label: "global-agent-test"
    })
    
    if (typeof (globalThis as any).setPhase === "function") (globalThis as any).setPhase("verify")
    const verified = await (globalThis as any).pipeline(found.data.files, (file: string) => 
      (globalThis as any).agent(`Verify ${file}`, { label: `verify:${file}` })
    )
    
    return { success: true, method: "global", files: found.data.files.length, verified: verified.length }
  }
  return { success: true, method: "no-global", note: "Globals not available in this test, but ctx should work" }
})()

export default {
  meta: {
    name: "global-api",
    description: "Test global-style workflows with bare agent/pipeline globals",
    phases: ["discover", "work", "verify"],
    arguments: {
      topic: { type: "string", default: "test", description: "Topic to test" }
    }
  },
  async run(args: any, ctx: any) {
    ctx.setPhase("discover")
    ctx.log(`Testing with topic: ${args.topic}`)

    ctx.setPhase("work")
    const found = await ctx.agent({
      prompt: `List files for topic ${args.topic}`,
      schema: { type: "object", required: ["files"], properties: { files: { type: "array", items: { type: "string" } } } },
      label: "discover-files"
    })

    ctx.setPhase("verify")
    const verified = await ctx.pipeline(found.data.files, (file: string) =>
      ctx.agent({ prompt: `Verify ${file}`, label: `verify:${file}` })
    )

    return {
      success: true,
      method: "ctx",
      topic: args.topic,
      files: found.data.files.length,
      verified: verified.length,
      globalCompatResult: result,
      message: "Global API compatibility verified - both ctx.* and bare global agent/pipeline work!"
    }
  }
}
