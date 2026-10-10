// CLI runner for claude / codex bots (spec §5, §5.5, §10.2). Owned by W2b in Phase 2.
import type { Engine } from "@bs-job-agents/shared";
import { ClaudeRunner } from "./claude/runner.js";
import type { RunnerDeps } from "./cli-runner.js";
import { CodexRunner } from "./codex/runner.js";
import { resolveRunnerConfig, type RunnerConfig } from "./config.js";
import type { Runner } from "./types.js";

export type { PermissionDenial, Runner, RunnerEvent, RunnerResult, RunnerTask } from "./types.js";
export { ClaudeRunner } from "./claude/runner.js";
export { CodexRunner } from "./codex/runner.js";
export type { RunnerDeps } from "./cli-runner.js";
export {
  DEFAULT_MCP_SERVERS,
  FIGMA_MCP_SERVER,
  ORCHESTRATOR_MCP_SERVER,
  defaultBotsDir,
  resolveRunnerConfig,
  type McpServerConfig,
  type RunnerConfig,
} from "./config.js";
export { BotDefinitionError, assertRunnableBot, botTaskKinds, loadBotDefinition, loadBots, readBotPromptFiles, rolePromptHash } from "./bots.js";
export { staleBotSchemas, writeBotSchemas } from "./schemas.js";
export { PromptSecurityError, UNTRUSTED_INPUT_FIELDS, buildPrompt } from "./prompt.js";
export { appendMemoryNotes, type AppendMemoryInput, type AppendMemoryResult } from "./memory.js";
export { RunnerConfigError, TaskSetupError } from "./errors.js";
export { killProcessGroup, nodeSpawn, type KillTreeFn, type SpawnFn } from "./process.js";

/** One runner per engine, sharing a config; the engine (W2a) picks by `bot.engine`. */
export function createRunners(config: Partial<RunnerConfig> = {}, deps: RunnerDeps = {}): Record<Engine, Runner> {
  const resolved = resolveRunnerConfig(config);
  return { claude: new ClaudeRunner(resolved, deps), codex: new CodexRunner(resolved, deps) };
}
