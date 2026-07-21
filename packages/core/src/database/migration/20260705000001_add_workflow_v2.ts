import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260705000001_add_workflow_v2",
  up(tx) {
    return Effect.gen(function* () {
      // Add new columns for Workflows v2
      yield* tx.run(`ALTER TABLE \`workflow_run\` ADD COLUMN \`phase_data\` text;`).pipe(Effect.ignore)
      yield* tx.run(`ALTER TABLE \`workflow_run\` ADD COLUMN \`state\` text;`).pipe(Effect.ignore)
    })
  },
} satisfies DatabaseMigration.Migration
