// Orchestrator start-up (W2a brief, PM S19 degraded start):
//   data folder check → lock → openDb (schema guard) → workflows/*.yaml → createProductionEngine →
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
import type { DegradedReason, Engine as EngineName } from "@bs-job-agents/shared";
import type { FastifyInstance, FastifyServerOptions } from "fastify";
import { FigmaBridge } from "../../bridges/index.js";
import { checkDataDir, type OrchestratorConfig } from "../../config.js";
import { SchemaGuardError, getOrCreateLeadRoom, openDb, type Db } from "../../db/index.js";
import {
  EngineError,
  botRegistryFrom,
  createProductionEngine,
  type BotRegistry,
  type BrowserStatusProbe,
  type Engine,
  type FigmaPort,
  type Logger,
} from "../../engine/index.js";
import { BotDefinitionError, createRunners, type Runner } from "../../runner/index.js";
import { buildServer } from "../../server.js";
import { dbEventHub, engineEventHub, type ApiContext, type OrchestratorState } from "../context.js";
import { lockDataFolder, type DataFolderLock } from "./lock.js";
import { WorkflowLoadError, yamlWorkflowSource, type YamlWorkflowSource } from "./workflows.js";

export interface StartOptions {
  config: OrchestratorConfig;
  /** Fastify's logger (pino options or true); the engine logs through it once the server exists. */
  logger?: FastifyServerOptions["logger"];
  /** Default: createRunners() (W2b), real CLIs. Tests pass a FakeRunner. */
  runners?: Record<EngineName, Runner>;
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
  if (db && workflows && !state) {
    try {
      engine = createProductionEngine({
        db,
        dataDir: config.dataDir,
        botsDir: config.botsDir,
        // W3a part 2 (S17) adds the orchestrator MCP server for Lead to this config.
        runners: opts.runners ?? createRunners(),
        workflows,
        figma,
        ...(opts.browser ? { browser: opts.browser } : {}),
        logger: log,
      });
      bots = engine.deps.bots;
    } catch (err) {
      degrade("bots_invalid", `bots/: ${message(err)}`);
    }
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
  };
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
        await figma.stop?.().catch(() => undefined);
        if (idle) db?.$client.close();
        lock?.release();
      })();
      return closed;
    },
  };
}
