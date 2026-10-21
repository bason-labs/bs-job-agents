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
// - skill self-repair §5.8, the API changed (404/410 on a listed endpoint, a body the mapper cannot
//   read, or postings that are all invalid): the same fallback to a browser scan for this run; Ba is
//   told once when the API turns broken and once when it works again (per-source API health). The
//   next run tries the API first, so recovery needs nothing from Ba. Endpoints are never re-researched
//   and access records or mappers are never changed automatically.
// Every text built on the board-API path passes the secret store's redactor.
import { ResearchScanInputSchema, SEARCH_SOURCES, isBoardSource, isFeedSource, type ResearchScanInput, type SelfCheckItem } from "@bs-job-agents/shared";
import { ApiChanged, AuthRejected, BoardApiError, DirectReadBlocked, MissingCredential } from "../adapters/board-api/index.js";
import { claimNextTask, getRun, getTask, holdEngineTasks, isEnginePaused, markSourceApiBroken, markSourceApiHealthy, requeueTask, routeTaskToBrowser, type Conn, type Task } from "../db/index.js";
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

/** §5.8: Ba's notice when a board's API stops working (posted once, when it turns broken). */
export function apiChangedNotice(source: string, reason: string): string {
  return `${sourceLabel(source)} API changed: ${reason}. Scanned through the browser this time; scans use the browser until the API works again.`;
}

/** QA L4: the board answered a direct read with a bot check (not a changed API). */
export function directReadBlockedNotice(source: string): string {
  return `${sourceLabel(source)} blocked the direct read — scanned through the browser this time.`;
}

/** §5.8: once, when a broken API works again. */
export function apiRecoveredNotice(source: string): string {
  return `${sourceLabel(source)} API works again; scans are back on the API.`;
}

/** Method, host and path only: anything after "?" or "#" is cut (§5.8). */
const withoutQuery = (text: string): string => text.replace(/[?#][^\s)]*/g, "");

/** A board read with no token (auth "none") answered 401/403, e.g. a bot check: there is no token to renew. */
export function directReadRefusedNotice(source: string, status: number): string {
  return `${sourceLabel(source)} refused the direct read (HTTP ${status}) — scanned through the browser this time.`;
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
    const board = !isFeedSource(input.source) && isBoardSource(input.source);
    // §5.8: the board answered postings, but not one of them is valid any more.
    if (board && fetched.jobs.length > 0 && settled.output && settled.output.jobs.length === 0 && settled.dropped.length === fetched.jobs.length) {
      this.apiChanged(task, new ApiChanged(null, null, `${sourceLabel(input.source)}: none of the ${fetched.jobs.length} postings the API gave is valid (${settled.dropped[0]})`));
      return;
    }
    if (settled.kind === "failed") {
      this.settleFailure(task, this.redact(settled.error), settled.retryable);
      return;
    }
    completeScanTask(core, task, settled.output, board ? (tx) => this.apiHealthy(tx, task) : undefined);
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
      else if (err instanceof MissingCredential) this.toBrowser(task, tokenFallbackNotice(source, "missing"));
      // QA L4: a bot check: the browser this run, the API health untouched.
      else if (err instanceof DirectReadBlocked) this.toBrowser(task, directReadBlockedNotice(source), undefined, `direct-read-blocked:${source}`);
      // §5.8: the API changed: this run reads the board in the browser; Ba hears it once.
      else if (err instanceof ApiChanged) this.apiChanged(task, err);
      // Whatever was fetched before the 401/403 is discarded: the browser scan covers the board.
      else if (err instanceof AuthRejected) {
        this.toBrowser(task, access.record?.auth.kind === "none" ? directReadRefusedNotice(source, err.status) : tokenFallbackNotice(source, "rejected"));
      }
      else this.settleFailure(task, this.redact(errorMessage(err)), err instanceof BoardApiError && err.kind === "transient");
      return null;
    }
    const note = `${result.jobs.length} posting${result.jobs.length === 1 ? "" : "s"}${result.note ? `; ${result.note}` : ""}`;
    return { jobs: result.jobs, selfCheck: [{ item: `Read ${label} through ${how} (no bot, no LLM)`, passed: true, note: this.redact(note) }] };
  }

  /**
   * §5.8: the board's API changed. Back to the queue as a browser scan (like a rejected token); the
   * API is marked broken, and only the change from working to broken posts a notice and an
   * Activity entry. The reason holds a method, host and path, never a query or a header.
   */
  private apiChanged(task: Task, err: ApiChanged): void {
    const source = String((task.input as { source?: unknown } | null)?.source ?? "");
    const reason = withoutQuery(this.redact(err.message));
    this.toBrowser(task, null, (tx) => {
      if (!markSourceApiBroken(tx, source, reason, { now: this.core.now() })) return;
      this.core.bus.emit(tx, { type: "source_api.changed", source, method: err.host ? "GET" : null, host: err.host, path: err.path ? withoutQuery(err.path) : null, reason });
      postNotice(this.core, tx, { text: apiChangedNotice(source, reason), runId: task.runId, cards: [{ type: "activity_link" }] });
    });
  }

  /** §5.8: a board's API scan succeeded: a broken API is marked working again, once. */
  private apiHealthy(tx: Conn, task: Task): void {
    const source = String((task.input as { source?: unknown } | null)?.source ?? "");
    if (!markSourceApiHealthy(tx, source, { now: this.core.now() })) return;
    this.core.bus.emit(tx, { type: "source_api.recovered", source });
    postNotice(this.core, tx, { text: apiRecoveredNotice(source), runId: task.runId });
  }

  /** Design §5.4: back to the queue as a browser scan of the same source, with Ba's renew notice. */
  private toBrowser(task: Task, notice: string | null, also?: (tx: Conn) => void, onceKey?: string): void {
    const core = this.core;
    const source = String((task.input as { source?: unknown } | null)?.source ?? "");
    try {
      core.db.transaction((tx) => {
        if (getTask(tx, task.id)?.status !== "running") return;
        const queued = routeTaskToBrowser(tx, task.id);
        if (isEnginePaused(tx, queued.engine, { now: core.now() })) holdEngineTasks(tx, queued.engine);
        if (notice) postNotice(core, tx, { text: notice, runId: task.runId, once: onceKey ?? `token-fallback:${source}` });
        also?.(tx);
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
