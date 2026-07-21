export default {
  meta: {
    name: "wf2-validate-child",
    description: "Validate child workflow structured attribution",
    phases: ["parent", "child-call", "verify", "Deploy: prod"],
    phaseValidation: "warn",
  },
  async run(args: any, ctx: any) {
    ctx.setPhase("parent", { parent: true })
    ctx.log("Parent log before child")
    
    // This phase title contains colon+space which old heuristic would misclassify as child
    ctx.setPhase("Deploy: prod" as any, { deploy: true })
    // The above should NOT be treated as child - it's a parent phase with colon
    // Our new structured child field prevents misclassification
    
    ctx.setPhase("child-call")
    
    const childResult = await ctx.workflow("wf2-validate-child-child", { test: "data" })
    
    ctx.setPhase("verify")
    
    // Self-assertions: we can inspect ctx's own run via state? But we need to check row data via API
    // For now, we just verify child result returned
    if (!childResult || (childResult as any).child !== true) {
      throw new Error(`Child workflow result invalid: ${JSON.stringify(childResult)}`)
    }
    
    // The validation harness will check persisted run row for child field
    // We record something in state to indicate we passed here
    ctx.state.set("childResultOk", true)
    ctx.state.set("deployPhaseTest", "Deploy: prod should NOT be child")
    
    return { success: true, childResult, message: "wf2-validate-child passed - check DB for child field attribution" }
  }
}
