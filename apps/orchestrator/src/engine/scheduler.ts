// Scheduler (§7.4, UC-02, UC-21): saved schedules start their workflow with the schedule's
// Search Profile (following its edits, UC-21b). croner computes the next fire time in the
// schedule's time zone; next_run_at lives in the database, so a restart picks up where it was.
// - Missed runs (Mac asleep or off): at most one catch-up per schedule, only if it was due
//   within the last 12 hours; older misses are skipped and logged.
// - No overlap (UC-02 a): a schedule does not start while its previous run is still scanning.
// - Soft-deleted schedules never fire, and are purged after the 6 s Undo window.
import { Cron } from "croner";
import { StartWorkflowInputSchema } from "@bs-job-agents/shared";
import {
  appendMessage,
  dueSchedules,
  getOrCreateLeadRoom,
  getSchedule,
  listActiveRuns,
  listSchedules,
  mappers,
  purgeDeletedSchedules,
  recordScheduleFired,
  updateSchedule,
  type Run,
  type Schedule,
} from "../db/index.js";
import { loadRunCtx } from "./context.js";
import type { EngineCore } from "./core.js";
import { errorMessage, invalidInput, notFound } from "./errors.js";
import { scanPhaseBusy } from "./workflow.js";

/** The next time `cron` fires strictly after `after`, in `timezone` (ISO, UTC). */
export function computeNextRunAt(cron: string, timezone: string, after: Date): string | null {
  const job = new Cron(cron, { timezone, paused: true });
  try {
    return job.nextRun(after)?.toISOString() ?? null;
  } finally {
    job.stop();
  }
}

export type StartScheduledRun = (schedule: Schedule, input: ReturnType<typeof StartWorkflowInputSchema.parse>) => Run;

export interface SchedulerTick {
  fired: { scheduleId: number; runId: number; catchUp: boolean }[];
  skipped: { scheduleId: number; reason: "overlap" | "missed" | "invalid" }[];
}

export class Scheduler {
  private timer: unknown = null;
  private stopped = true;

  constructor(
    private readonly core: EngineCore,
    private readonly startRun: StartScheduledRun,
  ) {}

  start(): void {
    this.stopped = false;
    this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.core.clock.clearTimer(this.timer);
    this.timer = null;
  }

  private arm(): void {
    if (this.stopped) return;
    if (this.timer !== null) this.core.clock.clearTimer(this.timer);
    this.timer = this.core.clock.setTimer(this.core.config.schedulerPollMs, () => {
      this.timer = null;
      this.tick();
    });
  }

  /**
   * UC-02a, refined (see the W2a report, PM2 decision 3 and M5): a schedule overlaps while a run it
   * started is paused, or still in its scan phase (a run-level step not finished). Per-job branches
   * waiting for Ba's review, and a source that only waits for Ba's login or CAPTCHA, do not hold
   * back the next scan.
   */
  overlaps(schedule: Schedule): boolean {
    for (const run of listActiveRuns(this.core.db)) {
      if (run.scheduleId !== schedule.id && run.id !== schedule.lastRunId) continue;
      if (run.status === "paused") return true;
      const ctx = loadRunCtx(this.core, run.id);
      if (!ctx || scanPhaseBusy(this.core.db, ctx)) return true;
    }
    return false;
  }

  private input(schedule: Schedule) {
    const params = { ...(schedule.params ?? {}), searchProfileId: schedule.searchProfileId === null ? null : String(schedule.searchProfileId) };
    const parsed = StartWorkflowInputSchema.safeParse({ workflow: schedule.workflowName, params });
    if (!parsed.success) throw invalidInput(`schedule ${schedule.id} has invalid params: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    return parsed.data;
  }

  private fire(schedule: Schedule, catchUp: boolean, nextRunAt: string | null): Run {
    const run = this.startRun(schedule, this.input(schedule));
    this.core.db.transaction((tx) => {
      recordScheduleFired(tx, schedule.id, { runId: run.id, nextRunAt }, { now: this.core.now() });
      this.core.bus.emit(tx, { type: "schedule.fired", scheduleId: String(schedule.id), runId: String(run.id), catchUp });
      // UC-02: Lead posts "Scheduled scan started" in the Lead chat, with the run card.
      const room = getOrCreateLeadRoom(tx, { now: this.core.now() });
      const message = appendMessage(
        tx,
        {
          roomId: room.id,
          author: "lead",
          text: `Scheduled scan started: ${schedule.name}${catchUp ? " (catch-up for a missed run)" : ""}.`,
          runRefs: [run.id],
          meta: { cards: [{ type: "run", runId: String(run.id) }] },
        },
        { now: this.core.now() },
      );
      this.core.bus.emit(tx, { type: "message.created", roomId: String(room.id), message: mappers.toMessage(message, room.kind, []) });
    });
    return run;
  }

  private skip(schedule: Schedule, reason: "overlap" | "missed", nextRunAt: string | null): void {
    this.core.db.transaction((tx) => {
      updateSchedule(tx, schedule.id, { nextRunAt }, { now: this.core.now() });
      this.core.bus.emit(tx, { type: "schedule.skipped", scheduleId: String(schedule.id), reason });
    });
  }

  /** Fire what is due now. Called on start (catch-up) and every schedulerPollMs. */
  tick(): SchedulerTick {
    const core = this.core;
    const now = core.now();
    const result: SchedulerTick = { fired: [], skipped: [] };
    try {
      purgeDeletedSchedules(core.db, { now });
      for (const s of listSchedules(core.db)) {
        if (s.enabled && s.nextRunAt === null) updateSchedule(core.db, s.id, { nextRunAt: computeNextRunAt(s.cron, s.timezone, now) }, { now });
      }
      for (const s of dueSchedules(core.db, { now })) {
        let next: string | null;
        try {
          next = computeNextRunAt(s.cron, s.timezone, now);
        } catch (err) {
          core.log.warn(`schedule ${s.id} has a bad cron "${s.cron}": ${errorMessage(err)}`);
          updateSchedule(core.db, s.id, { enabled: false }, { now });
          result.skipped.push({ scheduleId: s.id, reason: "invalid" });
          continue;
        }
        const lateMs = now.getTime() - new Date(s.nextRunAt!).getTime();
        if (lateMs > core.config.catchUpWindowMs) {
          this.skip(s, "missed", next);
          result.skipped.push({ scheduleId: s.id, reason: "missed" });
          continue;
        }
        if (this.overlaps(s)) {
          this.skip(s, "overlap", next);
          result.skipped.push({ scheduleId: s.id, reason: "overlap" });
          continue;
        }
        try {
          // Firing moves next_run_at past `now`, so a long sleep yields one catch-up, not one per missed slot.
          const run = this.fire(s, lateMs > core.config.catchUpAfterMs, next);
          result.fired.push({ scheduleId: s.id, runId: run.id, catchUp: lateMs > core.config.catchUpAfterMs });
        } catch (err) {
          core.log.warn(`schedule ${s.id} could not start: ${errorMessage(err)}`);
          updateSchedule(core.db, s.id, { nextRunAt: next }, { now });
          result.skipped.push({ scheduleId: s.id, reason: "invalid" });
        }
      }
    } finally {
      core.bus.flush();
      this.arm();
    }
    return result;
  }

  /** "Run now" on the Schedules screen (shared ScheduleRunNowResponseSchema). */
  runNow(scheduleId: number): { started: true; runId: number } | { started: false; reason: "overlap" } {
    const schedule = getSchedule(this.core.db, scheduleId);
    if (!schedule) throw notFound("schedule", scheduleId);
    if (this.overlaps(schedule)) return { started: false, reason: "overlap" };
    const run = this.fire(schedule, false, schedule.nextRunAt);
    this.core.bus.flush();
    return { started: true, runId: run.id };
  }
}
