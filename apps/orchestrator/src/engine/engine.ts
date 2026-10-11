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
  INTERRUPTED_APPLY_NOTE,
  applicationIdOfTask,
  createRun,
  getPromptVersion,
  getRun,
  getTask,
  listActiveRuns,
  listEvents,
  recordPromptVersion,
  recoverInterruptedTasks,
  resolveSearchProfile,
  syncBotFromDefinition,
  type Conn,
  type Db,
  type EventRow,
  type Run,
  type Task,
} from "../db/index.js";
import { rolePromptHash } from "../runner/bots.js";
import { answerQuestion, declineDomain, resumePausedTask, type AnswerInput } from "./apply.js";
import { BridgeWatcher } from "./bridges.js";
import { resolveEngineConfig, type EngineConfig, type EnginePaths } from "./config.js";
import { cancelRun, pauseRun, rerunStep, resumeRun } from "./control.js";
import type { EngineCore, EngineDeps } from "./core.js";
import { EngineError, invalidInput, notFound } from "./errors.js";
import { EventBus, type EventListener } from "./events.js";
import { LeadTools } from "./lead-tools.js";
import { silentLogger, type Clock, type Logger } from "./ports.js";
import { TaskQueue, lastFigmaBeforeHash } from "./queue.js";
import { createConversationTask, sinkFailed, type ConversationRequest } from "./conversations.js";
import { approve, confirmInjection, requestChanges, skip, type ApproveInput, type ApproveResult } from "./review.js";
import { Scheduler } from "./scheduler.js";
import { systemClock } from "./system.js";
import { noticeNeedsCheck, noticeTaskFailed } from "./notices.js";
import { emitSafetyDenied, failTaskNow, postLeadMessage } from "./task-events.js";
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
  /** CLI sessions those attempts persisted (kept only for a repair prompt), removed through their runner. */
  orphanSessions: string[];
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
    this.syncBots();
    await this.seedMemory();
    // UC-18 and S1: recovery and Lead's reports of it in one transaction.
    const r = this.db.transaction((tx) => {
      const recovered = recoverInterruptedTasks(tx, { now: this.now(), maxAttempts: this.config.maxAttempts });
      for (const appId of recovered.needsCheckApplicationIds) {
        const task = recovered.needsCheck.find((t) => applicationIdOfTask(t) === appId);
        noticeNeedsCheck(this, tx, appId, INTERRUPTED_APPLY_NOTE, { runId: task?.runId ?? null });
      }
      for (const t of recovered.exhausted) {
        noticeTaskFailed(this, tx, t, t.error ?? "interrupted by restart; no attempts left");
        sinkFailed(this, tx, t, t.error ?? "interrupted by restart; no attempts left");
      }
      return recovered;
    }, { behavior: "immediate" });
    const interrupted = [...r.requeued, ...r.exhausted, ...r.needsCheck];
    const orphanPids = this.killOrphans(interrupted);
    const orphanSessions = await this.removeOrphanSessions(interrupted);
    await this.checkFigmaAfterCrash([...r.requeued, ...r.exhausted]);
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
      orphanSessions,
    };
  }

  /**
   * The bots table from bot.json (rows that reference a bot need it: the Lead room, memory_changes,
   * prompt_versions), keeping Ba's Bots-screen changes; and §9 prompt_versions: each bot's ROLE.md
   * for its promptVersion. A ROLE.md that changed without a version bump refuses the start (PM
   * brief), so a prompt's history (sub-project C) never holds stale text.
   */
  private syncBots(): void {
    const now = this.now();
    this.db.transaction((tx) => {
      for (const def of this.deps.bots.list()) {
        syncBotFromDefinition(tx, {
          name: def.name,
          displayName: def.displayName,
          engine: def.engine,
          trustLevel: def.trustLevel,
          model: def.model,
          promptVersion: def.promptVersion,
          enabled: def.enabled,
        });
        if (!this.deps.prompts) continue;
        const text = this.deps.prompts.roleMd(def.name);
        const hash = rolePromptHash(text);
        const stored = getPromptVersion(tx, def.name, def.promptVersion);
        if (stored && stored.roleMdHash !== hash) {
          throw new EngineError(
            "conflict",
            `bots/${def.name}/ROLE.md changed but promptVersion is still ${def.promptVersion}: bump promptVersion in bots/${def.name}/bot.json`,
            { reason: "prompt_version_stale", bot: def.name },
          );
        }
        if (!stored) recordPromptVersion(tx, { botName: def.name, version: def.promptVersion, roleMdHash: hash, roleMdText: text }, { now });
      }
    });
  }

  /** PM2 S5: memory.md is gitignored; create each bot's missing file. Best effort: notes are appended later anyway. */
  private async seedMemory(): Promise<void> {
    const memory = this.deps.memory;
    if (!memory?.seed) return;
    try {
      await memory.seed(this.deps.bots.list().map((b) => b.name).sort());
    } catch (err) {
      this.log.warn(`could not seed the bots' memory files: ${err instanceof Error ? err.message : String(err)}`);
    }
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

  /**
   * UC-18: each interrupted attempt's CLI session (the runner persists it only for the repair
   * prompt and deletes it after the task, which a crash skips; it holds the prompt and Ba's data).
   * The last `runner.spawned` row of the task names the engine and the session. Best effort.
   */
  private async removeOrphanSessions(tasks: readonly Task[]): Promise<string[]> {
    const removed: string[] = [];
    for (const t of tasks) {
      const payload = listEvents(this.db, { taskId: t.id, types: ["runner.spawned"] }).at(-1)?.payload as { engine?: unknown; sessionId?: unknown } | undefined;
      const sessionId = payload?.sessionId;
      if (typeof sessionId !== "string" || sessionId === "") continue;
      const engine = payload?.engine === "claude" || payload?.engine === "codex" ? payload.engine : t.engine;
      const runner = this.deps.runners[engine];
      if (!runner?.removeSession) continue;
      try {
        await runner.removeSession(sessionId);
        removed.push(sessionId);
      } catch (err) {
        this.log.warn(`could not remove the CLI session ${sessionId} of task ${t.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return removed;
  }

  /**
   * PM2 S4: a CV task a crash interrupted may have changed a protected Figma page before its
   * after-check. Its spawn persisted the "before" hash; when Figma is reachable now, compare: a
   * change is a safety event and a Lead alert, and the task does not run again. When Figma is
   * not reachable, the task's next spawn compares instead (TaskQueue.prepare).
   */
  private async checkFigmaAfterCrash(tasks: readonly Task[]): Promise<void> {
    const cv = tasks
      .filter((t) => t.usesFigma)
      .map((t) => ({ task: t, hash: lastFigmaBeforeHash(this.db, t) }))
      .filter((x): x is { task: Task; hash: string } => x.hash !== null);
    if (cv.length === 0) return;
    let now: string;
    try {
      if (!(await this.deps.figma.status()).connected) return;
      now = (await this.deps.figma.fingerprintProtectedPages()).hash;
    } catch (err) {
      this.log.warn(`could not check the protected Figma pages after the restart: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.db.transaction((tx) => {
      for (const { task, hash } of cv) {
        if (hash === now) continue;
        const detail = "the protected Figma pages changed during a CV task that a restart interrupted, before the orchestrator could check them";
        emitSafetyDenied(this, tx, { botName: task.botName, taskId: task.id, action: "figma_execute", reason: "protected_page_changed", detail });
        postLeadMessage(
          this,
          tx,
          "A protected Figma page changed during a CV task that a restart interrupted, so I stopped it. Please check the file and restore the page from Figma's version history.",
          { runId: task.runId },
        );
        const current = getTask(tx, task.id);
        if (current?.status === "queued" || current?.status === "waiting_limit") failTaskNow(this, tx, current, `denied: ${detail}`);
      }
    });
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

  /** UC-11 e "Don't allow" (W3a request): Ba declines the domain Apply paused for; Apply ends (needs_check). */
  declineDomain(taskId: number): void {
    declineDomain(this, taskId);
  }

  runScheduleNow(scheduleId: number) {
    return this.scheduler.runNow(scheduleId);
  }

  /** UC-07 b: Ba confirms a flagged job is safe to apply to (audited: `injection.confirmed`). */
  confirmInjection(jobId: number): void {
    confirmInjection(this, jobId);
  }

  // ------------------------------------------------------------------ conversations (PM2 S2)

  /**
   * Queue Lead's chat (UC-01), a consult answer (UC-25) or a room reply (UC-15). The input is checked
   * against the bot's strict prompt schema before anything is queued; the task runs on the bot's
   * effective engine and waits out a usage limit. Its result reaches the ConversationSink.
   */
  enqueueConversation(req: ConversationRequest): { taskId: number } {
    // It dispatches after its commit: inside another transaction (e.g. a sink) use ctx.enqueue.
    if (this.db.$client.inTransaction) throw new EngineError("conflict", "enqueueConversation cannot run inside a transaction: a ConversationSink queues with ctx.enqueue");
    const task = this.db.transaction((tx) => createConversationTask(this, tx, req));
    this.bus.flush();
    this.dispatch();
    return { taskId: task.id };
  }

  /** Events after `afterId` as the UI sees them (SSE replay; audit-only rows are left out). */
  replay(afterId = 0): { event: AppEvent; row: EventRow }[] {
    return listEvents(this.db, { afterId })
      .map((row) => ({ row, event: this.bus.toAppEvent(row) }))
      .filter((e): e is { event: AppEvent; row: EventRow } => e.event !== null);
  }
}
