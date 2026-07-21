import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260721000001_add_guide",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("ALTER TABLE `workflow_run` ADD COLUMN `guide` text;").pipe(Effect.ignore)
    })
  },
} satisfies DatabaseMigration.Migration
