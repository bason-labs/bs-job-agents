// The engine (§4.2): workflow engine, task queue, concurrency limiter and locks, trust guard,
// usage-limit watcher, bridge waits, scheduler, crash recovery and Lead's tools, behind one
// object that W3a's API, SSE and MCP server call.
import {
  StartWorkflowInputSchema,
  type AppEvent,
  type Engine as EngineName,
  type PauseReason,
  type RunTrigger,
  type SkipDecision,
  type StartWorkflowInput,
} from "@bs-job-agents/shared";
import {
  createRun,
  getRun,
  listActiveRuns,
  listEvents,
  recoverInterruptedTasks,
  resolveSearchProfile,
  type Conn,
  type Db,
  type EventRow,
  type Run,
  type Task,
} from "../db/index.js";
import { answerQuestion, resumePausedTask, type AnswerInput } from "./apply.js";
import { BridgeWatcher } from "./bridges.js";
import { resolveEngineConfig, type EngineConfig, type EnginePaths } from "./config.js";
import { cancelRun, pauseRun, rerunStep, resumeRun } from "./control.js";
import type { EngineCore, EngineDeps } from "./core.js";
import { EngineError, invalidInput, notFound } from "./errors.js";
import { EventBus, type EventListener } from "./events.js";
import { LeadTools } from "./lead-tools.js";
import { silentLogger, type Clock, type Logger } from "./ports.js";
import { TaskQueue } from "./queue.js";
import { approve, requestChanges, skip, type ApproveInput, type ApproveResult } from "./review.js";
import { Scheduler } from "./scheduler.js";
import { systemClock } from "./system.js";
import { UsageWatcher } from "./usage.js";
import { advanceRun } from "./workflow.js";

export interface StartWorkflowOptions {
  trigger: RunTrigger;
  scheduleId?: number | null;
}

export interface StartReport {
  /** UC-18: tasks re-queued as a new attempt. */
  requeued: number[];
  /** Out of attempts after the crash: failed. */
  exhausted: number[];
  /** Interrupted apply.submit tasks: never re-queued; their applications went to needs_check. */
  needsCheck: number[];
  needsCheckApplications: number[];
  /** CLI process groups a crash left behind, by the pid their `started` event reported. */
  orphanPids: number[];
}

export class Engine implements EngineCore {
  readonly db: Db;
  readonly deps: EngineDeps;
  readonly config: EngineConfig;
  readonly paths: EnginePaths;
  readonly clock: Clock;
  readonly bus: EventBus;
  readonly log: Logger;
  readonly queue: TaskQueue;
  readonly usage: UsageWatcher;
  readonly bridges: BridgeWatcher;
  readonly scheduler: Scheduler;
  /** Lead's tools for the orchestrator MCP server (rule 5). */
  readonly lead: LeadTools;
  private running = false;

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.db = deps.db;
    this.config = resolveEngineConfig(deps.config);
    this.paths = deps.paths;
    this.clock = deps.clock ?? systemClock;
    this.log = deps.logger ?? silentLogger;
    this.bus = new EventBus(this.db, () => this.clock.now());
    this.queue = new TaskQueue(this);
    this.usage = new UsageWatcher(this);
    this.bridges = new BridgeWatcher(this);
    this.scheduler = new Scheduler(this, (schedule, input) => this.startWorkflow(input, { trigger: "schedule", scheduleId: schedule.id }));
    this.lead = new LeadTools(this, (input, opts) => this.startWorkflow(input, opts));
  }

  // ------------------------------------------------------------------ EngineCore

  now(): Date {
    return this.clock.now();
  }

  /** Never throws: the state change that triggered it is already committed; a bug is logged, not fatal. */
  advance(runId: number | null): void {
    try {
      if (runId !== null) advanceRun(this, runId);
    } catch (err) {
      this.log.error(`could not advance run ${runId}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    } finally {
      this.bus.flush();
    }
  }

  /** Never throws (see advance); a failed claim is retried on the next dispatch. */
  dispatch(): void {
    if (!this.running) return;
    try {
      this.queue.dispatch();
    } catch (err) {
      this.log.error(`could not dispatch tasks: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.bus.flush();
    }
  }

  pauseEngineForLimit(conn: Conn, engine: EngineName, resetsAt: string | null): void {
    this.usage.pause(conn, engine, resetsAt);
  }

  waitForBridge(
    conn: Conn,
    task: Task,
    reason: Extract<PauseReason["code"], "needs_browser" | "needs_figma">,
    opts: { detail?: string; output?: unknown } = {},
  ): void {
    this.bridges.wait(conn, task, reason, opts);
  }

  abortTask(taskId: number): boolean {
    return this.queue.abort(taskId);
  }

  // ------------------------------------------------------------------ lifecycle

  /**
   * Start-up (UC-18): recover tasks a crash left running (re-queue as a new attempt; an
   * interrupted Apply → needs_check, PM S2), kill their orphaned CLI process groups, resume
   * engine pauses that expired, re-arm bridge waits, continue every active run from its last
   * finished step, start the scheduler (catch-up runs) and the queue.
   */
  async start(): Promise<StartReport> {
    // Recovery marks every running task interrupted: never while this engine runs tasks itself.
    if (this.running) throw new EngineError("conflict", "the engine is already started");
    const r = recoverInterruptedTasks(this.db, { now: this.now(), maxAttempts: this.config.maxAttempts });
    const orphanPids = this.killOrphans([...r.requeued, ...r.exhausted, ...r.needsCheck]);
    this.bus.flush();
    this.running = true;
    this.queue.resume();
    this.usage.restore();
    this.bridges.start();
    for (const run of listActiveRuns(this.db)) this.advance(run.id);
    this.scheduler.start();
    this.dispatch();
    return {
      requeued: r.requeued.map((t) => t.id),
      exhausted: r.exhausted.map((t) => t.id),
      needsCheck: r.needsCheck.map((t) => t.id),
      needsCheckApplications: r.needsCheckApplicationIds,
      orphanPids,
    };
  }

  /** Stop claiming and stop the timers. Running tasks are left to finish (or to recovery). */
  stop(): void {
    this.running = false;
    this.queue.stop();
    this.scheduler.stop();
    this.usage.stop();
    this.bridges.stop();
  }

  /** Resolves when no task runs and nothing more can start now (tests; graceful shutdown). */
  async idle(): Promise<void> {
    for (;;) {
      await this.queue.idle();
      const poll = this.bridges.pending();
      if (!poll) return;
      await poll;
    }
  }

  private killOrphans(tasks: readonly Task[]): number[] {
    const pids: number[] = [];
    for (const t of tasks) {
      const spawned = listEvents(this.db, { taskId: t.id, types: ["runner.spawned"] }).at(-1);
      const pid = (spawned?.payload as { pid?: unknown } | undefined)?.pid;
      if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) continue;
      pids.push(pid);
      try {
        this.deps.processes?.killGroup(pid);
      } catch (err) {
        this.log.warn(`could not stop the orphaned CLI group ${pid} of task ${t.id}: ${String(err)}`);
      }
    }
    return pids;
  }

  /** SSE (W3a): committed shared events in order, including the ones repositories append. */
  subscribe(listener: EventListener): () => void {
    return this.bus.subscribe(listener);
  }

  // ------------------------------------------------------------------ workflows

  /**
   * Start a workflow (UC-01, UC-02, UC-14, UC-24). The run pins the Search Profile version it
   * starts with (UC-21b). Refused when the master CV is missing (UC-01 c) or a scan has no profile.
   */
  startWorkflow(input: StartWorkflowInput, opts: StartWorkflowOptions): Run {
    const parsed = StartWorkflowInputSchema.safeParse(input);
    if (!parsed.success) throw invalidInput("invalid workflow input", parsed.error.issues);
    const def = this.deps.workflows.get(parsed.data.workflow);
    if (!def) throw notFound("workflow", parsed.data.workflow);
    if (!def.triggers.includes(opts.trigger)) throw invalidInput(`${def.name} cannot be started by a ${opts.trigger} trigger`);
    if (this.deps.masterCv.version() === null) {
      throw new EngineError("conflict", "the master CV is missing: add it on the Master CV screen first (UC-01 c)", { reason: "master_cv_missing" });
    }
    const profileId = parsed.data.params.searchProfileId === null ? null : Number(parsed.data.params.searchProfileId);
    const profile = resolveSearchProfile(this.db, profileId);
    if (parsed.data.workflow === "job-scan" && !profile) {
      throw new EngineError("conflict", "there are no search criteria yet (UC-21b)", { reason: "no_search_profile" });
    }
    const run = this.db.transaction((tx) => {
      const created = createRun(
        tx,
        {
          workflowName: def.name,
          workflowVersion: def.version,
          trigger: opts.trigger,
          params: parsed.data.params as Record<string, unknown>,
          searchProfileVersion: profile?.version ?? null,
          searchProfileId: profile?.id ?? null,
          scheduleId: opts.scheduleId ?? null,
        },
        { now: this.now() },
      );
      this.bus.emit(tx, {
        type: "run.started",
        runId: String(created.id),
        workflowName: def.name,
        trigger: opts.trigger,
        scheduleId: opts.scheduleId === null || opts.scheduleId === undefined ? null : String(opts.scheduleId),
      });
      return created;
    });
    this.advance(run.id);
    this.dispatch();
    return getRun(this.db, run.id)!;
  }

  pauseRun(runId: number): void {
    pauseRun(this, runId);
  }

  resumeRun(runId: number): void {
    resumeRun(this, runId);
  }

  cancelRun(runId: number): number[] {
    return cancelRun(this, runId);
  }

  rerunStep(stepId: number): void {
    rerunStep(this, stepId);
  }

  // ------------------------------------------------------------------ Ba's decisions

  approve(jobId: number, input: ApproveInput): ApproveResult {
    return approve(this, jobId, input);
  }

  requestChanges(jobId: number, comment: string): void {
    requestChanges(this, jobId, comment);
  }

  skip(jobId: number, decision: SkipDecision): void {
    skip(this, jobId, decision);
  }

  answerQuestion(taskId: number, input: AnswerInput) {
    return answerQuestion(this, taskId, input);
  }

  resumeTask(taskId: number, opts: { confirmDomain?: string | null } = {}): void {
    resumePausedTask(this, taskId, opts);
  }

  runScheduleNow(scheduleId: number) {
    return this.scheduler.runNow(scheduleId);
  }

  /** Events after `afterId` as the UI sees them (SSE replay; audit-only rows are left out). */
  replay(afterId = 0): { event: AppEvent; row: EventRow }[] {
    return listEvents(this.db, { afterId })
      .map((row) => ({ row, event: this.bus.toAppEvent(row) }))
      .filter((e): e is { event: AppEvent; row: EventRow } => e.event !== null);
  }
}
