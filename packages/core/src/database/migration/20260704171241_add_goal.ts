import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260704171241_add_goal",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`goal\` (
          \`session_id\` text NOT NULL,
          \`text\` text NOT NULL,
          \`status\` text NOT NULL,
          \`budget_tokens\` integer,
          \`tokens_used\` integer NOT NULL DEFAULT 0,
          \`time_ms\` integer NOT NULL DEFAULT 0,
          \`started_at\` integer NOT NULL,
          \`paused_at\` integer,
          \`completed_at\` integer,
          \`verification\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          PRIMARY KEY (\`session_id\`),
          FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON UPDATE no action ON DELETE cascade
        );
      `)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`goal_session_idx\` ON \`goal\` (\`session_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
