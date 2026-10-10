// needs_browser / needs_figma waits (§4.4, §6.2, §10.3, UC-17): a browser task finds Chrome or
// its extension not connected, or a CV task finds the Figma bridge down → the task waits with
// that reason (the UI shows why), Ba is told through bridge.status, and the task goes back to
// the queue by itself when the probe reports the bridge connected again. Other steps keep running.
import type { Engine } from "@bs-job-agents/shared";
import { getTask, listTasks, pauseTask, type Conn, type Task } from "../db/index.js";
import type { EngineCore } from "./core.js";
import { emitTaskPaused, resumeTaskNow } from "./task-events.js";

export type BridgeReason = "needs_browser" | "needs_figma";

const DETAIL: Record<BridgeReason, string> = {
  needs_browser: "Chrome is not running or its extension is not connected",
  needs_figma: "Figma desktop with the CV file and the Desktop Bridge plugin is not running",
};

export class BridgeWatcher {
  private timer: unknown = null;
  private stopped = false;
  private running: Promise<number> | null = null;

  constructor(private readonly core: EngineCore) {}

  /**
   * Pause a claimed task until its bridge is back (inside `conn`'s transaction). `detail` is what
   * Ba should do (e.g. the Figma status message); `output` keeps state for the next spawn.
   */
  wait(conn: Conn, task: Task, reason: BridgeReason, opts: { detail?: string; output?: unknown } = {}): void {
    const pauseReason = { code: reason, site: null, detail: opts.detail ?? DETAIL[reason] };
    const paused = pauseTask(conn, task.id, pauseReason, opts.output !== undefined ? { output: opts.output } : {});
    emitTaskPaused(this.core, conn, paused, pauseReason);
    this.core.bus.emit(conn, {
      type: "bridge.status",
      bridge: reason === "needs_browser" ? "chrome" : "figma",
      engine: reason === "needs_browser" ? task.engine : null,
      connected: false,
    });
    this.arm();
  }

  /** Poll again after bridgePollMs while any task waits for a bridge. */
  arm(): void {
    if (this.stopped || this.timer !== null) return;
    this.timer = this.core.clock.setTimer(this.core.config.bridgePollMs, () => {
      this.timer = null;
      void this.poll();
    });
  }

  waiting(): Task[] {
    return listTasks(this.core.db, { status: "paused" }).filter((t) => t.pauseReason === "needs_browser" || t.pauseReason === "needs_figma");
  }

  /** Check the bridges now and requeue the tasks whose bridge is back. Returns how many resumed. */
  poll(): Promise<number> {
    this.running ??= this.check().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** The in-flight poll, if any (Engine.idle waits for it). */
  pending(): Promise<number> | null {
    return this.running;
  }

  private async check(): Promise<number> {
    const core = this.core;
    const waiting = this.waiting();
    if (waiting.length === 0) return 0;
    const chrome = new Map<Engine, boolean>();
    let figma: boolean | null = null;
    const probe = async (fn: () => Promise<boolean>) => {
      try {
        return await fn();
      } catch {
        return false;
      }
    };
    for (const t of waiting) {
      if (t.pauseReason === "needs_browser" && !chrome.has(t.engine)) chrome.set(t.engine, await probe(() => core.deps.browser.isConnected(t.engine)));
      if (t.pauseReason === "needs_figma" && figma === null) figma = await probe(async () => (await core.deps.figma.status()).connected);
    }
    let resumed = 0;
    core.db.transaction((tx) => {
      for (const [engine, connected] of chrome) if (connected) core.bus.emit(tx, { type: "bridge.status", bridge: "chrome", engine, connected: true });
      if (figma) core.bus.emit(tx, { type: "bridge.status", bridge: "figma", engine: null, connected: true });
      for (const t of waiting) {
        const back = t.pauseReason === "needs_browser" ? chrome.get(t.engine) === true : figma === true;
        const current = getTask(tx, t.id);
        if (!back || current?.status !== "paused" || current.pauseReason !== t.pauseReason) continue;
        resumeTaskNow(core, tx, current);
        resumed++;
      }
    });
    core.bus.flush();
    if (resumed > 0) core.dispatch();
    if (this.waiting().length > 0) this.arm();
    return resumed;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.core.clock.clearTimer(this.timer);
    this.timer = null;
  }

  start(): void {
    this.stopped = false;
    if (this.waiting().length > 0) this.arm();
  }
}
