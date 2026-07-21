export default {
  meta: {
    name: "wf2-validate-child-child",
    description: "Tiny child workflow for validation",
    phases: ["child-phase"],
  },
  async run(args: any, ctx: any) {
    ctx.setPhase("child-phase", { child: true, data: args })
    ctx.log("Child log message without agent")
    // No agent needed for M1 validation - child attribution via logs is enough
    return { child: true, data: args }
  }
}
