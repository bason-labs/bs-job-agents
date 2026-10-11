// PM2 S17: how a Lead spawn reaches the orchestrator MCP server with its own capability.
// The runner config names MCP servers statically, so a per-spawn credential needs a per-spawn
// config: for a bot that uses the `orchestrator` server (only Lead, by checkBotSafety), this runner
// mints a capability, builds a runner whose `mcpServers.orchestrator` is
// `{ url: http://127.0.0.1:<port>/mcp/<token>, knownTools }`, runs the task with it and revokes the
// token when the spawn returns. Claude gets the URL in its per-task mcp.json (not in argv), and the
// six knownTools let it hide any tool Lead's bot.json does not allow. Every other bot runs on the
// shared base runner unchanged.
import type { Engine as EngineName } from "@bs-job-agents/shared";
import { ClaudeRunner, CodexRunner, ORCHESTRATOR_MCP_SERVER, resolveRunnerConfig, type McpServerConfig, type Runner, type RunnerConfig, type RunnerDeps } from "../runner/index.js";
import type { RunnerEvent, RunnerResult, RunnerTask } from "../runner/index.js";
import { chatModeOfKind, type CapabilityStore } from "./capabilities.js";
import type { OrchestratorMcpServer } from "./server.js";
import { ORCHESTRATOR_TOOLS } from "./tools.js";

/** Slack on top of the task's timeout (the repair round, process teardown); the revoke normally comes first. */
export const CAPABILITY_TTL_MARGIN_MS = 5 * 60_000;

export interface LeadMcpRunnerOptions {
  capabilities: CapabilityStore;
  server: () => OrchestratorMcpServer | null;
  /** A runner whose config carries this spawn's orchestrator server. */
  spawnRunner: (orchestrator: McpServerConfig) => Runner;
}

/** The orchestrator server config for one capability URL. */
export function orchestratorServerConfig(url: string): McpServerConfig {
  return { url, knownTools: [...ORCHESTRATOR_TOOLS] };
}

function roomIdOf(input: unknown): number | null {
  const raw = (input as { roomId?: unknown } | null)?.roomId;
  const n = typeof raw === "string" && /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : typeof raw === "number" ? raw : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export class LeadMcpRunner implements Runner {
  readonly engine: Runner["engine"];

  constructor(
    private readonly base: Runner,
    private readonly opts: LeadMcpRunnerOptions,
  ) {
    this.engine = base.engine;
  }

  async run(task: RunnerTask, onEvent: (event: RunnerEvent) => void): Promise<RunnerResult> {
    if (!task.bot.mcpServers.includes(ORCHESTRATOR_MCP_SERVER)) return this.base.run(task, onEvent);
    const server = this.opts.server();
    if (!server) return { status: "failed", error: "the orchestrator MCP server is not running", exitCode: null, durationMs: 0 };
    const token = this.opts.capabilities.mint({
      taskId: task.taskId,
      attempt: task.attempt,
      caller: { botName: task.bot.name, mode: chatModeOfKind(task.kind) },
      roomId: roomIdOf(task.input),
      ttlMs: task.timeoutMs * 2 + CAPABILITY_TTL_MARGIN_MS,
    });
    try {
      return await this.opts.spawnRunner(orchestratorServerConfig(server.url(token))).run(task, onEvent);
    } finally {
      this.opts.capabilities.revoke(token);
    }
  }

  removeSession(sessionId: string): Promise<void> {
    return this.base.removeSession?.(sessionId) ?? Promise.resolve();
  }
}

/**
 * createRunners() with the orchestrator MCP server for Lead (S17). `config` and `deps` are the
 * runner's own (tests pass a fake spawn).
 */
export function createOrchestratorRunners(opts: {
  capabilities: CapabilityStore;
  server: () => OrchestratorMcpServer | null;
  config?: Partial<RunnerConfig>;
  deps?: RunnerDeps;
}): Record<EngineName, Runner> {
  const base = resolveRunnerConfig(opts.config ?? {});
  const withOrchestrator = (orchestrator: McpServerConfig): RunnerConfig => ({
    ...base,
    mcpServers: { ...base.mcpServers, [ORCHESTRATOR_MCP_SERVER]: orchestrator },
  });
  const wrap = (engine: EngineName): Runner => {
    const make = (cfg: RunnerConfig): Runner => (engine === "claude" ? new ClaudeRunner(cfg, opts.deps) : new CodexRunner(cfg, opts.deps));
    return new LeadMcpRunner(make(base), {
      capabilities: opts.capabilities,
      server: opts.server,
      spawnRunner: (orchestrator) => make(withOrchestrator(orchestrator)),
    });
  };
  return { claude: wrap("claude"), codex: wrap("codex") };
}
