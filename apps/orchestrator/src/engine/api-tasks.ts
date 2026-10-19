// W5 + API research (AD-5, AD-6, design §5.4): research.scan tasks the orchestrator fetches itself.
// The scan's map step creates a research.scan task per source as usual, so the Flows canvas, the
// join (failed sources listed, the others go on), dedupe, fit and top work unchanged. A task whose
// source is read through a feed, a public API or an account API (engine/access.ts, decided when the
// task is created) is never given to a runner: the queue hands it here. No bot, no LLM, no Chrome
// tool, no engine session or usage limit (claimed apart from the engine caps; never held by a usage
// pause). Its output settles through settleScanOutput, like every non-browser scan.
// Failures:
// - transient (429, 5xx, connection, timeout) or a failed feed: retried like any task attempt
//   (§5.5 step 6), then the source fails: "<Source> scan failed: <reason>. The other sources go on."
// - account API with its token missing (no request sent) or rejected (401/403, any jobs fetched so
//   far discarded): the same task goes back to the queue as a browser scan, so this run still
//   covers the board and the join does not count a failed source; Ba is asked to renew the token.
// Every text built on the board-API path passes the secret store's redactor.
import { ResearchScanInputSchema, SEARCH_SOURCES, isBoardSource, isFeedSource, type ResearchScanInput, type SelfCheckItem } from "@bs-job-agents/shared";
import { AuthRejected, BoardApiError, MissingCredential } from "../adapters/board-api/index.js";
import { claimNextTask, getRun, getTask, holdEngineTasks, isEnginePaused, requeueTask, routeTaskToBrowser, type Task } from "../db/index.js";
import { sourceAccess } from "./access.js";
import type { EngineCore } from "./core.js";
import { errorMessage } from "./errors.js";
import { sinkFailed } from "./conversations.js";
import { noticeTaskFailed, postNotice, sourceLabel } from "./notices.js";
import { completeScanTask, settleScanOutput } from "./scan-settle.js";
import { emitTaskFinished, failTaskNow } from "./task-events.js";

/** Fetches at a time (each host also queues its own requests behind the 1.5 s gap). */
export const API_CONCURRENCY = 4;

interface ApiInflight {
  promise: Promise<void>;
  controller: AbortController;
}

/** What one fetch gave before settling. */
interface Fetched {
  jobs: readonly unknown[];
  selfCheck: SelfCheckItem[];
}

/** Ba's notice when an account-API board falls back to the browser (design §5.4). */
export function tokenFallbackNotice(source: string, why: "missing" | "rejected"): string {
  const label = sourceLabel(source);
  return `${label} token ${why} — scanned through the browser this time. Renew the ${label} token in your secrets file.`;
}

export class ApiTaskRunner {
  private readonly inflight = new Map<number, ApiInflight>();

  constructor(private readonly core: EngineCore) {}

  running(): number {
    return this.inflight.size;
  }

  pending(): Promise<void>[] {
    return [...this.inflight.values()].map((e) => e.promise);
  }

  abort(taskId: number): boolean {
    const entry = this.inflight.get(taskId);
    if (!entry) return false;
    entry.controller.abort();
    return true;
  }

  /** Claim and start the queued API tasks (sync). */
  dispatch(): void {
    while (this.inflight.size < API_CONCURRENCY) {
      const task = claimNextTask(this.core.db, { apiTasks: "only", respectEnginePause: false, now: this.core.now() });
      if (!task) return;
      this.start(task);
    }
  }

  private start(task: Task): void {
    const entry: ApiInflight = { promise: Promise.resolve(), controller: new AbortController() };
    this.inflight.set(task.id, entry);
    entry.promise = this.execute(task, entry.controller.signal)
      .catch((err: unknown) => this.settleFailure(task, `engine error: ${this.redact(errorMessage(err))}`, false))
      .finally(() => {
        this.inflight.delete(task.id);
        // Both never throw (they log): this promise must never reject.
        this.core.advance(task.runId);
        this.core.dispatch();
      });
  }

  private redact(text: string): string {
    return this.core.deps.boards?.redact(text) ?? text;
  }

  private progress(task: Task, text: string, tool: string | null = null): void {
    const ref = { taskId: String(task.id), runId: task.runId === null ? null : String(task.runId), stepId: task.stepId === null ? null : String(task.stepId), botName: task.botName };
    this.core.db.transaction((tx) => {
      this.core.bus.emit(tx, { type: "task.progress", ...ref, kind: "status", text: this.redact(text), tool });
    });
    this.core.bus.flush();
  }

  private async execute(task: Task, signal: AbortSignal): Promise<void> {
    const core = this.core;
    const parsed = ResearchScanInputSchema.safeParse(task.input);
    if (!parsed.success) {
      this.settleFailure(task, "an API task needs a research.scan input", false);
      return;
    }
    const input = parsed.data;
    const ref = { taskId: String(task.id), runId: task.runId === null ? null : String(task.runId), stepId: task.stepId === null ? null : String(task.stepId), botName: task.botName };
    core.db.transaction((tx) => {
      core.bus.emit(tx, { type: "task.started", ...ref, kind: task.kind, engine: task.engine, attempt: task.attempt });
    });
    core.bus.flush();
    const fetched = isFeedSource(input.source) ? await this.fetchFeed(task, input, signal) : await this.fetchBoard(task, input, signal);
    if (!fetched) return;
    const settled = await settleScanOutput({
      source: input.source,
      taskInput: task.input,
      jobs: fetched.jobs,
      selfCheck: fetched.selfCheck,
      taskId: task.id,
      runId: task.runId,
      attempt: task.attempt,
      engine: task.engine,
      ...(core.deps.scanChecker ? { checker: core.deps.scanChecker } : {}),
      log: core.log,
    });
    if (settled.dropped.length > 0) this.progress(task, `Dropped ${settled.dropped.length} invalid posting${settled.dropped.length === 1 ? "" : "s"}: ${settled.dropped.join("; ")}`);
    if (settled.kind === "failed") {
      this.settleFailure(task, this.redact(settled.error), settled.retryable);
      return;
    }
    completeScanTask(core, task, settled.output);
  }

  private async fetchFeed(task: Task, input: ResearchScanInput, signal: AbortSignal): Promise<Fetched | null> {
    const source = input.source;
    if (!isFeedSource(source)) return null;
    this.progress(task, `Reading the ${SEARCH_SOURCES[source].label} feed (fetched by the orchestrator: no bot, no LLM)`);
    const feeds = this.core.deps.feeds;
    if (!feeds) {
      this.settleFailure(task, `feed sources are not wired in this orchestrator (${source})`, false);
      return null;
    }
    try {
      const output = await feeds.scan(source, input, signal);
      return { jobs: output.jobs, selfCheck: output.selfCheck };
    } catch (err) {
      this.settleFailure(task, signal.aborted ? "cancelled" : errorMessage(err), !signal.aborted);
      return null;
    }
  }

  private async fetchBoard(task: Task, input: ResearchScanInput, signal: AbortSignal): Promise<Fetched | null> {
    const core = this.core;
    const source = input.source;
    const boards = core.deps.boards;
    const access = sourceAccess(core.db, boards, source);
    // The path changed since the task was queued (approval revoked, mapper gone): read it in the browser.
    if (!boards || !isBoardSource(source) || access.path === "browser") {
      this.progress(task, `${sourceLabel(source)} is read in the browser now`);
      this.toBrowser(task, null);
      return null;
    }
    const label = sourceLabel(source);
    const how = access.path === "public_api" ? "its public API" : "its account API";
    this.progress(task, `Reading ${label} through ${how} (fetched by the orchestrator: no bot, no LLM)`);
    let result: { jobs: unknown[]; note?: string };
    try {
      result = await boards.scan(source, {
        path: access.path,
        input,
        signal,
        // REQ-23.AC-2 evidence: method, host and path only.
        onRequest: (r) => this.progress(task, `${r.method} ${r.host}${r.path}`, "board-api"),
      });
    } catch (err) {
      if (signal.aborted) this.settleFailure(task, "cancelled", false);
      else if (err instanceof MissingCredential) this.toBrowser(task, "missing");
      // Whatever was fetched before the 401/403 is discarded: the browser scan covers the board.
      else if (err instanceof AuthRejected) this.toBrowser(task, "rejected");
      else this.settleFailure(task, this.redact(errorMessage(err)), err instanceof BoardApiError && err.kind === "transient");
      return null;
    }
    const note = `${result.jobs.length} posting${result.jobs.length === 1 ? "" : "s"}${result.note ? `; ${result.note}` : ""}`;
    return { jobs: result.jobs, selfCheck: [{ item: `Read ${label} through ${how} (no bot, no LLM)`, passed: true, note: this.redact(note) }] };
  }

  /** Design §5.4: back to the queue as a browser scan of the same source, with Ba's renew notice. */
  private toBrowser(task: Task, token: "missing" | "rejected" | null): void {
    const core = this.core;
    const source = String((task.input as { source?: unknown } | null)?.source ?? "");
    try {
      core.db.transaction((tx) => {
        if (getTask(tx, task.id)?.status !== "running") return;
        const queued = routeTaskToBrowser(tx, task.id);
        if (isEnginePaused(tx, queued.engine, { now: core.now() })) holdEngineTasks(tx, queued.engine);
        if (token) postNotice(core, tx, { text: tokenFallbackNotice(source, token), runId: task.runId, once: `token-fallback:${source}` });
      });
    } catch (err) {
      core.log.error(`could not send task ${task.id} to the browser: ${errorMessage(err)}`);
    }
  }

  /** A failed attempt: retried (§5.5 step 6) when `retry` and attempts are left; then the source fails for good. */
  private settleFailure(task: Task, error: string, retry: boolean): void {
    const core = this.core;
    try {
      core.db.transaction((tx) => {
        const current = getTask(tx, task.id);
        if (current?.status !== "running") return;
        const cancelled = task.runId !== null && getRun(tx, task.runId)?.status === "cancelled";
        if (retry && !cancelled && current.attempt < core.config.maxAttempts) {
          emitTaskFinished(core, tx, current, "failed", error);
          requeueTask(tx, task.id, { newAttempt: true });
          return;
        }
        const failed = failTaskNow(core, tx, current, error);
        if (!cancelled) noticeTaskFailed(core, tx, failed, error);
        sinkFailed(core, tx, failed, error);
      });
    } catch (inner) {
      core.log.error(`could not record the failure of API task ${task.id}: ${errorMessage(inner)}`);
    }
  }
}
