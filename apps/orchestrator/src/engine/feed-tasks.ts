// W5: feed sources in a job scan (Remote OK, We Work Remotely, Remotive, Jobspresso). The scan's
// map step creates a research.scan task per source as usual, so the Flows canvas, the join (failed
// sources listed, the others go on), dedupe, fit and top work unchanged. A feed source's task is
// never given to a runner: the queue hands it here, the orchestrator fetches the board's public
// feed (deps.feeds, src/adapters/feeds) and settles the task with research.scan's output shape.
// No bot, no LLM, no engine session or usage limit (claimed apart from the engine caps; never held
// by a usage pause). A failed fetch is retried once like any task attempt (§5.5 step 6), then the
// source fails.
import { ResearchScanInputSchema, SEARCH_SOURCES, isFeedSource, type ResearchScanOutput } from "@bs-job-agents/shared";
import { claimNextTask, completeTask, getRun, getTask, requeueTask, type Task } from "../db/index.js";
import type { EngineCore } from "./core.js";
import { errorMessage } from "./errors.js";
import { sinkFailed } from "./conversations.js";
import { noticeTaskFailed } from "./notices.js";
import { emitTaskFinished, failTaskNow } from "./task-events.js";

/** Feed fetches at a time (each board also queues its own requests). */
export const FEED_CONCURRENCY = 4;

interface FeedInflight {
  promise: Promise<void>;
  controller: AbortController;
}

export class FeedTaskRunner {
  private readonly inflight = new Map<number, FeedInflight>();

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

  /** Claim and start the queued feed tasks (sync). */
  dispatch(): void {
    while (this.inflight.size < FEED_CONCURRENCY) {
      const task = claimNextTask(this.core.db, { feedTasks: "only", respectEnginePause: false, now: this.core.now() });
      if (!task) return;
      this.start(task);
    }
  }

  private start(task: Task): void {
    const entry: FeedInflight = { promise: Promise.resolve(), controller: new AbortController() };
    this.inflight.set(task.id, entry);
    entry.promise = this.execute(task, entry.controller.signal)
      .catch((err: unknown) => this.settleFailure(task, `engine error: ${errorMessage(err)}`, false))
      .finally(() => {
        this.inflight.delete(task.id);
        // Both never throw (they log): this promise must never reject.
        this.core.advance(task.runId);
        this.core.dispatch();
      });
  }

  private async execute(task: Task, signal: AbortSignal): Promise<void> {
    const core = this.core;
    const parsed = ResearchScanInputSchema.safeParse(task.input);
    if (!parsed.success || !isFeedSource(parsed.data.source)) {
      this.settleFailure(task, "a feed task needs a research.scan input with a feed source", false);
      return;
    }
    const source = parsed.data.source;
    const ref = { taskId: String(task.id), runId: task.runId === null ? null : String(task.runId), stepId: task.stepId === null ? null : String(task.stepId), botName: task.botName };
    core.db.transaction((tx) => {
      core.bus.emit(tx, { type: "task.started", ...ref, kind: task.kind, engine: task.engine, attempt: task.attempt });
      core.bus.emit(tx, { type: "task.progress", ...ref, kind: "status", text: `Reading the ${SEARCH_SOURCES[source].label} feed (fetched by the orchestrator: no bot, no LLM)`, tool: null });
    });
    core.bus.flush();
    const feeds = core.deps.feeds;
    if (!feeds) {
      this.settleFailure(task, `feed sources are not wired in this orchestrator (${source})`, false);
      return;
    }
    let output: ResearchScanOutput;
    try {
      output = await feeds.scan(source, parsed.data, signal);
    } catch (err) {
      this.settleFailure(task, signal.aborted ? "cancelled" : errorMessage(err), !signal.aborted);
      return;
    }
    core.db.transaction((tx) => {
      const current = getTask(tx, task.id);
      if (current?.status !== "running") return;
      const done = completeTask(tx, task.id, { output, now: core.now() });
      emitTaskFinished(core, tx, done, "done", null);
    });
  }

  /** A failed attempt: retried once (§5.5 step 6) unless cancelled; then the source fails for good. */
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
      core.log.error(`could not record the failure of feed task ${task.id}: ${errorMessage(inner)}`);
    }
  }
}
