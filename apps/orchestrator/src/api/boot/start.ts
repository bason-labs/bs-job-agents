// Orchestrator start-up (W2a brief, PM S19 degraded start):
//   data folder check → lock → openDb (schema guard) → workflows/*.yaml → Lead's MCP server (S17) →
//   createProductionEngine (runners with per-spawn Lead capabilities, the chat sink, S20) →
//   engine.start() (UC-18 recovery) → the Lead chat → HTTP + SSE on 127.0.0.1.
// Any refusal on the way (a data folder path the bots cannot read, a missing immutability trigger,
// an invalid workflow or bot.json, a ROLE.md changed without a promptVersion bump) leaves the
// engine stopped, but HTTP and SSE still serve: /health answers 503 with the reason and /status
// says what happened, instead of the UI showing "orchestrator unreachable".
// Shutdown: stop the engine (no new tasks), close HTTP (SSE included), wait a bounded time for
// running tasks, close the database, release the lock. Tasks still running then are recovered at
// the next start (UC-18).
import { accessSync, constants, mkdirSync } from "node:fs";
import { join } from "node:path";
import { checkBotSafety, type DegradedReason, type Engine as EngineName } from "@bs-job-agents/shared";
import type { FastifyInstance, FastifyServerOptions } from "fastify";
import { FigmaBridge } from "../../bridges/index.js";
import { checkDataDir, type OrchestratorConfig } from "../../config.js";
import { SchemaGuardError, getBot, getOrCreateLeadRoom, openDb, type Db } from "../../db/index.js";
import {
  EngineError,
  botRegistryFrom,
  createProductionEngine,
  type BotRegistry,
  type BrowserStatusProbe,
  type Engine,
  type EngineConfig,
  type FigmaPort,
  type Logger,
} from "../../engine/index.js";
import { CapabilityStore, createOrchestratorRunners, startMcpServer, type OrchestratorMcpServer } from "../../mcp/index.js";
import { BotDefinitionError, type Runner } from "../../runner/index.js";
import { ChatSink } from "../chat/sink.js";
import { FactDraftStore } from "../fact-drafts.js";
import { defaultNotifier, startNotifications, type Notifier } from "../notify.js";
import { ProposalStore } from "../proposals.js";
import { buildServer } from "../../server.js";
import { dbEventHub, engineEventHub, type ApiContext, type OrchestratorState } from "../context.js";
import { lockDataFolder, type DataFolderLock } from "./lock.js";
import { WorkflowLoadError, yamlWorkflowSource, type YamlWorkflowSource } from "./workflows.js";

export interface StartOptions {
  config: OrchestratorConfig;
  /** Fastify's logger (pino options or true); the engine logs through it once the server exists. */
  logger?: FastifyServerOptions["logger"];
  /**
   * Default: the real CLIs, with the orchestrator MCP server for Lead (createOrchestratorRunners,
   * S17). Tests pass a FakeRunner, or a function that wraps one around the live MCP server.
   */
  runners?: Record<EngineName, Runner> | ((mcp: { capabilities: CapabilityStore; server: () => OrchestratorMcpServer | null }) => Record<EngineName, Runner>);
  /** UC-02 macOS notification (default: osascript on macOS unless ORCH_NOTIFY=0; null = off). */
  notify?: Notifier | null;
  /** Default: W2c's FigmaBridge. */
  figma?: FigmaPort & { stop?: () => Promise<void> };
  /** Default: the Chrome probe. */
  browser?: BrowserStatusProbe;
  now?: () => Date;
  /** How long to wait for another orchestrator to release the data folder (default 15 s). */
  lockWaitMs?: number;
  /** How long shutdown waits for running tasks (default 10 s). */
  shutdownGraceMs?: number;
  /** SSE heartbeat (default 15 s). */
  heartbeatMs?: number;
  /** Engine settings over the defaults (tests only; production uses DEFAULT_ENGINE_CONFIG, §12 gate on). */
  engineConfig?: Partial<EngineConfig>;
}

export interface Orchestrator {
  ctx: ApiContext;
  app: FastifyInstance;
  /** Listen on 127.0.0.1:<config.port>; returns the address. */
  listen(): Promise<string>;
  /** The port it listens on (after listen). */
  port(): number;
  close(): Promise<void>;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A logger whose sink moves from the console to Fastify's logger once the server exists. */
function lateLogger(): { log: Logger; attach(sink: Logger): void } {
  let sink: Logger = {
    info: (m, ...a) => console.info(`[orchestrator] ${m}`, ...a),
    warn: (m, ...a) => console.warn(`[orchestrator] ${m}`, ...a),
    error: (m, ...a) => console.error(`[orchestrator] ${m}`, ...a),
  };
  return {
    log: { info: (m, ...a) => sink.info(m, ...a), warn: (m, ...a) => sink.warn(m, ...a), error: (m, ...a) => sink.error(m, ...a) },
    attach: (next) => {
      sink = next;
    },
  };
}

/** Why engine.start() refused (the stale-ROLE.md refusal carries its reason in details). */
function startFailureReason(err: unknown): DegradedReason {
  if (err instanceof EngineError && (err.details as { reason?: unknown } | null)?.reason === "prompt_version_stale") return "prompt_version_stale";
  if (err instanceof BotDefinitionError) return "bots_invalid";
  return "engine_start_failed";
}

/**
 * PM3 M1: the engine each bot would run on (its Bots-screen row over bot.json) checked against the
 * Phase 1 safety rules; null when every bot is safe.
 */
export function unsafeStoredEngines(db: Db, registry: BotRegistry): string | null {
  const problems: string[] = [];
  for (const def of registry.list()) {
    const row = getBot(db, def.name);
    const engine = row?.engine ?? def.engine;
    if (engine === def.engine) continue;
    // Owner decision 2026-10-11: CV on Codex is fine once Ba acknowledged the risk.
    const issues = checkBotSafety({ ...def, engine }, { unguardedFigmaAcknowledged: (row?.engineRiskAckAt ?? null) !== null });
    if (issues.length > 0) {
      const label = def.displayName || def.name;
      problems.push(`${issues.join("; ")}. ${label} is set to ${engine === "codex" ? "Codex" : engine} on the Bots screen: switch it back to Claude, then restart the orchestrator`);
    }
  }
  return problems.length > 0 ? problems.join(". ") : null;
}

export async function startOrchestrator(opts: StartOptions): Promise<Orchestrator> {
  const { config } = opts;
  const now = opts.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const logging = lateLogger();
  const log = logging.log;
  let state: OrchestratorState | null = null;
  const degrade = (reason: DegradedReason, detail: string) => {
    state ??= { state: "degraded", reason, detail, startedAt };
    log.error(`degraded start (${reason}): ${detail}`);
  };

  let lock: DataFolderLock | null = null;
  let db: Db | null = null;
  let workflows: YamlWorkflowSource | null = null;
  let engine: Engine | null = null;
  let bots: BotRegistry | null = null;
  // Owned here, so its figma-console-mcp child process is stopped at shutdown.
  const figma: FigmaPort & { stop?: () => Promise<void> } = opts.figma ?? new FigmaBridge();

  const dir = checkDataDir(config.dataDir);
  if (!dir.ok) degrade("data_dir_invalid", dir.detail);
  else {
    try {
      mkdirSync(config.dataDir, { recursive: true });
      accessSync(config.dataDir, constants.R_OK | constants.W_OK);
    } catch (err) {
      degrade("data_dir_invalid", `the data folder ${config.dataDir} cannot be used: ${message(err)}`);
    }
  }
  if (!state) {
    // A live orchestrator on this folder is fatal: never two engines on one database.
    lock = await lockDataFolder(config.dataDir, { waitMs: opts.lockWaitMs });
    try {
      db = openDb(join(config.dataDir, "app.db"));
    } catch (err) {
      degrade(err instanceof SchemaGuardError ? "schema_guard" : "db_open_failed", message(err));
    }
  }
  if (db && !state) {
    try {
      workflows = yamlWorkflowSource({ dir: config.workflowsDir, db, now });
    } catch (err) {
      degrade("workflows_invalid", err instanceof WorkflowLoadError ? err.message : `workflows/: ${message(err)}`);
    }
  }
  // S17: Lead's tools. Its listener starts before the engine (the runners need its URL); the tools
  // bind to the engine once it exists. Without it, Lead could not run: start-up degrades instead.
  const capabilities = new CapabilityStore();
  const proposals = new ProposalStore({ dataDir: config.dataDir, now, workflows: () => workflows });
  const sink = new ChatSink({ capabilities, now, log, dataDir: config.dataDir, workflows: () => workflows });
  let mcp: OrchestratorMcpServer | null = null;
  const custom = typeof opts.runners === "object" ? opts.runners : null;
  if (db && workflows && !state && !custom) {
    try {
      mcp = await startMcpServer({ capabilities, tools: () => (engine && state?.state === "running" ? { engine, proposals, capabilities } : null), log });
    } catch (err) {
      degrade("engine_start_failed", `the orchestrator MCP server for Lead could not start: ${message(err)}`);
    }
  }
  if (db && workflows && !state) {
    try {
      const mcpPort = { capabilities, server: () => mcp };
      engine = createProductionEngine({
        db,
        dataDir: config.dataDir,
        botsDir: config.botsDir,
        runners: custom ?? (typeof opts.runners === "function" ? opts.runners(mcpPort) : createOrchestratorRunners(mcpPort)),
        workflows,
        figma,
        conversations: sink,
        // Owner request 2026-10-11: CV's fact drafts from Ba's words go into data/master-cv.yaml.
        factDrafts: new FactDraftStore({ dataDir: config.dataDir }),
        ...(opts.browser ? { browser: opts.browser } : {}),
        ...(opts.engineConfig ? { config: opts.engineConfig } : {}),
        logger: log,
      });
      bots = engine.deps.bots;
    } catch (err) {
      degrade("bots_invalid", `bots/: ${message(err)}`);
    }
  }
  // PM3 M1: a Bots-screen change stored before the rule existed (Lead on Codex) never runs: the
  // engine stays stopped with the reason, and the Bots screen can switch it back.
  if (engine && db && !state) {
    const unsafe = unsafeStoredEngines(db, engine.deps.bots);
    if (unsafe) degrade("bots_invalid", unsafe);
  }
  if (engine && db && !state) {
    try {
      const report = await engine.start();
      getOrCreateLeadRoom(db, { now: now() });
      state = {
        state: "running",
        startedAt,
        recovered: { requeued: report.requeued.length, exhausted: report.exhausted.length, needsCheck: report.needsCheck.length },
      };
    } catch (err) {
      engine.stop();
      degrade(startFailureReason(err), message(err));
    }
  }
  if (!bots) {
    try {
      bots = botRegistryFrom(config.botsDir);
    } catch {
      bots = null;
    }
  }

  const ctx: ApiContext = {
    config: { dataDir: config.dataDir, botsDir: config.botsDir, workflowsDir: config.workflowsDir, port: config.port, webOrigins: config.webOrigins },
    state: state ?? { state: "degraded", reason: "engine_start_failed", detail: "the engine did not start", startedAt },
    db,
    engine,
    bots,
    workflows,
    events: engine ? engineEventHub(engine) : db ? dbEventHub(db, now) : null,
    now,
    log,
    proposals,
    capabilities,
  };
  const notify = opts.notify === undefined ? defaultNotifier() : opts.notify;
  const stopNotifications = notify && ctx.events && engine ? startNotifications(ctx.events, notify) : null;
  const app = buildServer(ctx, { logger: opts.logger ?? false, ...(opts.heartbeatMs ? { heartbeatMs: opts.heartbeatMs } : {}) });
  logging.attach({
    info: (m) => app.log.info(m),
    warn: (m) => app.log.warn(m),
    error: (m) => app.log.error(m),
  });

  let closed: Promise<void> | null = null;
  const port = (): number => {
    const a = app.server.address();
    return a !== null && typeof a === "object" ? a.port : config.port;
  };

  return {
    ctx,
    app,
    port,
    async listen() {
      await app.listen({ host: config.host, port: config.port });
      return `http://${config.host}:${port()}`;
    },
    close() {
      closed ??= (async () => {
        engine?.stop();
        await app.close();
        let idle = true;
        if (engine) {
          const grace = new Promise<false>((resolve) => setTimeout(() => resolve(false), opts.shutdownGraceMs ?? 10_000).unref());
          idle = await Promise.race([engine.idle().then(() => true as const), grace]);
          if (!idle) log.warn("tasks were still running at shutdown; the next start recovers them (UC-18)");
        }
        stopNotifications?.();
        await mcp?.close().catch(() => undefined);
        await figma.stop?.().catch(() => undefined);
        if (idle) db?.$client.close();
        lock?.release();
      })();
      return closed;
    },
  };
}
