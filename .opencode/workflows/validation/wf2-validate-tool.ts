export default {
  meta: {
    name: "wf2-validate-tool",
    description: "Validate real tool() delegation",
    phases: ["test"],
  },
  async run(args: any, ctx: any) {
    ctx.setPhase("test")
    
    // Create a known file to read
    const testFilePath = ".opencode/workflows/validation/test-file.txt"
    const testContent = "Hello from tool validation - this is real file content"
    
    // Write file via shell (or we assume file exists from setup)
    await ctx.shell(`echo "${testContent}" > ${testFilePath}`)
    
    // Now read via ctx.tool - should return real contents, not stub
    const result = await ctx.tool("read", { path: testFilePath })
    
    if (!result || !result.output) {
      throw new Error("tool read returned null or empty")
    }
    
    if (!result.output.includes("Hello from tool validation")) {
      throw new Error(`tool read did not return real file contents, got: ${result.output}`)
    }
    
    if (result.output === "tool read called" || result.output.includes("tool read called")) {
      throw new Error("tool() still returns stub string, not real delegation")
    }
    
    return { success: true, content: result.output, message: "wf2-validate-tool passed" }
  }
}
