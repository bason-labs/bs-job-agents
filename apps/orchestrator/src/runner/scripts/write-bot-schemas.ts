// pnpm --filter @bs-job-agents/orchestrator bots:schemas [botsDir]
// Regenerates bots/<name>/schemas/*.json from packages/shared (build shared first).
import { resolve } from "node:path";
import { defaultBotsDir } from "../config.js";
import { writeBotSchemas } from "../schemas.js";

const botsDir = process.argv[2] ? resolve(process.argv[2]) : defaultBotsDir();
const changed = writeBotSchemas(botsDir);
console.info(changed.length === 0 ? `bot schemas in ${botsDir} are up to date` : `updated:\n${changed.map((c) => `  ${c}`).join("\n")}`);
