// Usage-limit watcher (UC-16, §4.2): a usage limit (RunnerResult usage_limit, or a usage event
// that is limited or at ≥ 0.95 utilization) pauses that engine until its reset time — or for 30
// minutes when the time is unknown, then tries again — and holds its queued tasks as
// waiting_limit. At the reset the engine resumes by itself and the held tasks go back to the
// queue. No engine switching (owner decision).
import type { Engine } from "@bs-job-agents/shared";
import { getEngineState, holdEngineTasks, listEngineStates, pauseEngine, releaseEngineTasks, resumeEngine, type Conn } from "../db/index.js";
import type { EngineCore } from "./core.js";
import { noticeEnginePaused, noticeEngineResumed } from "./notices.js";

export class UsageWatcher {
  private readonly timers = new Map<Engine, unknown>();

  constructor(private readonly core: EngineCore) {}

  /** Pause `engine` (inside `conn`'s transaction) until `resetsAt`, or for usageRetryMs when unknown. */
  pause(conn: Conn, engine: Engine, resetsAt: string | null): void {
    const core = this.core;
    const now = core.now();
    const reset = resetsAt === null ? null : new Date(resetsAt);
    const until = reset && !Number.isNaN(reset.getTime()) && reset > now ? reset : new Date(now.getTime() + core.config.usageRetryMs);
    const state = getEngineState(conn, engine);
    const wasPaused = state.pausedUntil !== null && new Date(state.pausedUntil) > now;
    holdEngineTasks(conn, engine);
    if (state.pausedUntil !== null && new Date(state.pausedUntil) >= until) return;
    pauseEngine(conn, engine, { until, reason: "usage_limit" });
    core.bus.emit(conn, { type: "engine.paused", engine, until: until.toISOString(), reason: "usage_limit" });
    // S1: one message per pause (not when the same pause is extended).
    if (!wasPaused) noticeEnginePaused(core, conn, engine, until.toISOString());
    this.schedule(engine, until);
  }

  private schedule(engine: Engine, until: Date): void {
    const old = this.timers.get(engine);
    if (old !== undefined) this.core.clock.clearTimer(old);
    this.timers.set(
      engine,
      this.core.clock.setTimer(until.getTime() - this.core.now().getTime(), () => this.resume(engine)),
    );
  }

  /** UC-16 step 5: the queue resumes by itself at the reset. */
  resume(engine: Engine): void {
    const core = this.core;
    this.timers.delete(engine);
    const resumed = core.db.transaction((tx) => {
      const state = getEngineState(tx, engine);
      if (state.pausedUntil !== null && new Date(state.pausedUntil) > core.now()) {
        this.schedule(engine, new Date(state.pausedUntil));
        return false;
      }
      if (state.pausedUntil === null && state.reason === null) {
        releaseEngineTasks(tx, engine);
        return false;
      }
      resumeEngine(tx, engine);
      releaseEngineTasks(tx, engine);
      core.bus.emit(tx, { type: "engine.resumed", engine });
      noticeEngineResumed(core, tx, engine);
      return true;
    });
    core.bus.flush();
    if (resumed) core.dispatch();
  }

  /** After a restart: resume pauses that expired while the orchestrator was down; re-arm the others. */
  restore(): void {
    for (const state of listEngineStates(this.core.db)) {
      if (state.pausedUntil === null) continue;
      const until = new Date(state.pausedUntil);
      if (until <= this.core.now()) this.resume(state.engine);
      else this.schedule(state.engine, until);
    }
  }

  stop(): void {
    for (const t of this.timers.values()) this.core.clock.clearTimer(t);
    this.timers.clear();
  }
}
