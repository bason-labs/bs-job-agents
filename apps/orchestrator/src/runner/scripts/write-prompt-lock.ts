// pnpm --filter @bs-job-agents/orchestrator bots:lock [botsDir]
// Updates bots/prompt-versions.json after a promptVersion bump (PM2 S6). Refuses a ROLE.md that
// changed without a bump: bump promptVersion in bots/<name>/bot.json first.
import { resolve } from "node:path";
import { defaultBotsDir } from "../config.js";
import { PromptLockError, updatePromptLock } from "../prompt-lock.js";

const botsDir = process.argv[2] ? resolve(process.argv[2]) : defaultBotsDir();
try {
  const changed = updatePromptLock(botsDir);
  console.info(changed.length === 0 ? `the prompt-version lock in ${botsDir} is up to date` : `updated the lock for: ${changed.join(", ")}`);
} catch (err) {
  if (!(err instanceof PromptLockError)) throw err;
  console.error(err.message);
  process.exitCode = 1;
}
