// Scheduler (§7.4, UC-02, UC-21, UC-21b), on a fake clock.
import { describe, expect, it } from "vitest";
import {
  createSchedule,
  getRun,
  getSchedule,
  listMessages,
  listRooms,
  listRuns,
  restoreSchedule,
  softDeleteSchedule,
  updateSearchProfile,
} from "../db/index.js";
import { computeNextRunAt } from "./scheduler.js";
import { createTestEngine } from "./testing/harness.js";

const T0 = new Date("2026-10-10T08:00:00.000Z"); // a Saturday, 15:00 in Ho Chi Minh City
const at = (ms: number) => new Date(T0.getTime() + ms).toISOString();
const HOUR = 3600_000;
const MONDAY_9_HCM = "2026-10-12T02:00:00.000Z";

describe("next fire time (croner)", () => {
  it("weekdays 09:00 in Asia/Ho_Chi_Minh (§15.2)", () => {
    expect(computeNextRunAt("0 9 * * 1-5", "Asia/Ho_Chi_Minh", T0)).toBe(MONDAY_9_HCM);
    expect(computeNextRunAt("0 9 * * 1-5", "Asia/Ho_Chi_Minh", new Date(MONDAY_9_HCM))).toBe("2026-10-13T02:00:00.000Z");
    expect(computeNextRunAt("30 7 * * *", "UTC", T0)).toBe("2026-10-11T07:30:00.000Z");
  });
});

describe("scheduler (§7.4, UC-02, UC-21)", () => {
  it("a due schedule starts its workflow with its Search Profile, moves next_run_at on and Lead posts the run card", async () => {
    const t = await createTestEngine();
    const s = createSchedule(t.db, { name: "Weekdays 9:00", cron: "0 9 * * 1-5", workflowName: "job-scan", nextRunAt: at(0) });
    const tick = t.engine.scheduler.tick();
    expect(tick.fired).toEqual([{ scheduleId: s.id, runId: expect.any(Number), catchUp: false }]);
    const run = getRun(t.db, tick.fired[0]!.runId)!;
    expect(run).toMatchObject({ trigger: "schedule", scheduleId: s.id, searchProfileId: t.profile!.id, searchProfileVersion: 1 });
    expect(getSchedule(t.db, s.id)).toMatchObject({ lastRunId: run.id, nextRunAt: MONDAY_9_HCM });
    expect(t.events("schedule.fired")).toEqual([expect.objectContaining({ scheduleId: String(s.id), runId: String(run.id), catchUp: false })]);
    const lead = listRooms(t.db, { kind: "lead" })[0]!;
    expect(listMessages(t.db, lead.id).at(-1)).toMatchObject({ author: "lead", text: "Scheduled scan started: Weekdays 9:00.", runRefs: [run.id] });
    await t.idle();
    expect(t.review(run.id, 1)).toBeDefined();
  });

  it("a new schedule gets its first fire time; disabled schedules never fire", async () => {
    const t = await createTestEngine();
    const s = createSchedule(t.db, { name: "Weekdays", cron: "0 9 * * 1-5", workflowName: "job-scan" });
    const off = createSchedule(t.db, { name: "Off", cron: "* * * * *", workflowName: "job-scan", enabled: false, nextRunAt: at(-60_000) });
    expect(t.engine.scheduler.tick().fired).toEqual([]);
    expect(getSchedule(t.db, s.id)?.nextRunAt).toBe(MONDAY_9_HCM);
    expect(getSchedule(t.db, off.id)?.lastRunId).toBeNull();
  });

  it("skips while its previous run is still scanning (UC-02 a); a run that only waits for Ba's review does not block", async () => {
    const t = await createTestEngine();
    t.runner.script({ bot: "research", kind: "scan", times: 1, delayMs: 1000 });
    const s = createSchedule(t.db, { name: "Hourly", cron: "0 * * * *", workflowName: "job-scan", nextRunAt: at(0) });
    const first = t.engine.scheduler.tick().fired[0]!;
    t.db.$client.prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(at(0), s.id);
    expect(t.engine.scheduler.tick()).toMatchObject({ fired: [], skipped: [{ scheduleId: s.id, reason: "overlap" }] });
    expect(t.events("schedule.skipped")).toEqual([expect.objectContaining({ scheduleId: String(s.id), reason: "overlap" })]);
    expect(getSchedule(t.db, s.id)?.nextRunAt).toBe(at(HOUR));

    await t.flush();
    t.clock.advance(1000);
    await t.idle();
    expect(getRun(t.db, first.runId)?.status).toBe("waiting"); // the review card waits for Ba
    t.clock.advance(HOUR); // the scheduler's own poll fires the next hour's run
    expect(t.events("schedule.fired").map((e) => e.scheduleId)).toEqual([String(s.id), String(s.id)]);
  });

  it("a soft-deleted schedule never fires; Undo restores it; after the 6 s window it is purged (UC-21)", async () => {
    const t = await createTestEngine();
    const s = createSchedule(t.db, { name: "Daily", cron: "0 9 * * *", workflowName: "job-scan", nextRunAt: at(0) });
    softDeleteSchedule(t.db, s.id, { now: t.clock.now() });
    expect(t.engine.scheduler.tick().fired).toEqual([]);
    restoreSchedule(t.db, s.id);
    expect(t.engine.scheduler.tick().fired).toHaveLength(1);

    const gone = createSchedule(t.db, { name: "Gone", cron: "0 9 * * *", workflowName: "job-scan", nextRunAt: at(0) });
    softDeleteSchedule(t.db, gone.id, { now: t.clock.now() });
    t.clock.advance(6_000);
    t.engine.scheduler.tick();
    expect(getSchedule(t.db, gone.id, { includeDeleted: true })).toBeUndefined();
    // Deleting a schedule while its run is active does not cancel the run.
    expect(listRuns(t.db).every((r) => r.status !== "cancelled")).toBe(true);
  });

  it("after a sleep, a run missed within 12 hours fires once as a catch-up; older misses are skipped (§7.4)", async () => {
    const t = await createTestEngine();
    const recent = createSchedule(t.db, { name: "Recent", cron: "0 * * * *", workflowName: "job-scan", nextRunAt: at(-3 * HOUR) });
    const old = createSchedule(t.db, { name: "Old", cron: "0 9 * * *", timezone: "UTC", workflowName: "job-scan", nextRunAt: at(-13 * HOUR) });
    const tick = t.engine.scheduler.tick();
    expect(tick.fired).toEqual([{ scheduleId: recent.id, runId: expect.any(Number), catchUp: true }]);
    expect(tick.skipped).toEqual([{ scheduleId: old.id, reason: "missed" }]);
    // One catch-up only: next_run_at jumps to the next slot after now, not to each missed hour.
    expect(getSchedule(t.db, recent.id)?.nextRunAt).toBe(at(HOUR));
    expect(getSchedule(t.db, old.id)?.nextRunAt).toBe("2026-10-10T09:00:00.000Z");
    expect(t.events("schedule.skipped")).toEqual([expect.objectContaining({ scheduleId: String(old.id), reason: "missed" })]);
  });

  it("a schedule follows edits to its Search Profile; a run keeps the version it started with (UC-21b)", async () => {
    const t = await createTestEngine();
    const s = createSchedule(t.db, { name: "Daily", cron: "0 9 * * *", workflowName: "job-scan", searchProfileId: t.profile!.id, nextRunAt: at(0) });
    const v2 = updateSearchProfile(t.db, { maxJobs: 3 }, { now: t.clock.now() });
    const run = getRun(t.db, t.engine.scheduler.tick().fired[0]!.runId)!;
    expect(run).toMatchObject({ searchProfileId: v2.id, searchProfileVersion: 2 });
    updateSearchProfile(t.db, { maxJobs: 1 }, { now: t.clock.now() });
    await t.idle();
    expect(t.step(run.id, "top")?.output).toMatchObject({ take: 3 });
    expect(s.id).toBeGreaterThan(0);
  });

  it("Run now starts at once, or reports the overlap", async () => {
    const t = await createTestEngine();
    t.runner.script({ bot: "research", kind: "scan", delayMs: 1000 });
    const s = createSchedule(t.db, { name: "Weekdays", cron: "0 9 * * 1-5", workflowName: "job-scan" });
    expect(t.engine.runScheduleNow(s.id)).toEqual({ started: true, runId: expect.any(Number) });
    expect(t.engine.runScheduleNow(s.id)).toEqual({ started: false, reason: "overlap" });
  });

  it("polls by itself on the clock", async () => {
    const t = await createTestEngine();
    createSchedule(t.db, { name: "Soon", cron: "1 8 * * *", timezone: "UTC", workflowName: "job-scan" });
    t.engine.scheduler.tick(); // next_run_at = 08:01Z
    t.clock.advance(30_000);
    expect(t.events("schedule.fired")).toEqual([]);
    t.clock.advance(30_000);
    expect(t.events("schedule.fired")).toHaveLength(1);
  });
});
