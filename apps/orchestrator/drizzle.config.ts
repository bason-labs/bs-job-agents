import { defineConfig } from "drizzle-kit";

// `pnpm --filter @bs-job-agents/orchestrator db:generate` writes SQL migrations
// to ./drizzle; openDb() applies them at start-up (src/db/client.ts).
// Hand-written migrations (triggers) are created with `drizzle-kit generate --custom`.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
