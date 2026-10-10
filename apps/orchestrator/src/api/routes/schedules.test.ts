import { ScheduleDeleteResponseSchema, ScheduleRunNowResponseSchema, ScheduleViewSchema, SchedulesResponseSchema } from "@bs-job-agents/shared";
import { afterEach, describe, expect, it } from "vitest";
import { computeNextRunAt } from "../../engine/index.js";
import { getSchedule, listSchedules } from "../../db/index.js";
import { createApiHarness, type ApiHarness } from "../testing.js";

let h: ApiHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const weekday = { name: "Weekday morning scan", cron: "0 9 * * 1-5", searchProfileId: null };

async function create(x: ApiHarness, body: Record<string, unknown> = weekday) {
  const res = await x.post("/schedules", body);
  expect(res.statusCode, res.body).toBe(201);
  return ScheduleViewSchema.parse(res.json());
}

describe("schedules (UC-21, §7.4, S23)", () => {
  it("POST creates one with the defaults and computes its next run (Asia/Ho_Chi_Minh)", async () => {
    h = await createApiHarness();
    const s = await create(h);
    expect(s).toMatchObject({ name: "Weekday morning scan", workflowName: "job-scan", timezone: "Asia/Ho_Chi_Minh", enabled: true, lastRunId: null, lastResult: null, deletedAt: null });
    expect(s.nextRunAt).toBe(computeNextRunAt("0 9 * * 1-5", "Asia/Ho_Chi_Minh", h.t.clock.now()));
    expect(SchedulesResponseSchema.parse((await h.get("/schedules")).json()).schedules.map((x) => x.id)).toEqual([s.id]);
    expect(ScheduleViewSchema.parse((await h.get(`/schedules/${s.id}`)).json()).id).toBe(s.id);
    expect((await h.get("/schedules/999")).statusCode).toBe(404);
  });

  it("refuses a 4-field cron, an unknown time zone or workflow, one a schedule cannot start, bad params and an unknown profile", async () => {
    h = await createApiHarness();
    for (const body of [
      { ...weekday, cron: "0 9 * *" },
      { ...weekday, timezone: "Mars/Olympus" },
      { ...weekday, workflowName: "nope" },
      { ...weekday, workflowName: "apply-to-link" },
      { ...weekday, params: { maxJobs: 5 } },
      { ...weekday, params: { overrides: { maxJobs: 500 } } },
      { ...weekday, searchProfileId: "999" },
      { ...weekday, name: " " },
    ]) {
      expect((await h.post("/schedules", body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(listSchedules(h.t.db)).toEqual([]);
    expect((await create(h, { ...weekday, params: { overrides: { maxJobs: 3 } } })).params).toEqual({ overrides: { maxJobs: 3 } });
  });

  it("PATCH recomputes the next run on every edit; disabling clears it, enabling sets it again", async () => {
    h = await createApiHarness();
    const s = await create(h);
    const edited = ScheduleViewSchema.parse((await h.patch(`/schedules/${s.id}`, { cron: "30 18 * * *" })).json());
    expect(edited.nextRunAt).toBe(computeNextRunAt("30 18 * * *", "Asia/Ho_Chi_Minh", h.t.clock.now()));
    const off = ScheduleViewSchema.parse((await h.patch(`/schedules/${s.id}`, { enabled: false })).json());
    expect(off.nextRunAt).toBeNull();
    h.t.clock.advance(3 * 24 * 3600_000);
    const on = ScheduleViewSchema.parse((await h.patch(`/schedules/${s.id}`, { enabled: true })).json());
    expect(on.nextRunAt).toBe(computeNextRunAt("30 18 * * *", "Asia/Ho_Chi_Minh", h.t.clock.now()));
    expect((await h.patch(`/schedules/${s.id}`, { deletedAt: null })).statusCode).toBe(400);
    expect((await h.patch(`/schedules/${s.id}`, { cron: "bad" })).statusCode).toBe(400);
    expect((await h.patch("/schedules/999", { enabled: false })).statusCode).toBe(404);
  });

  it("DELETE soft-deletes with a 6 s undo; restore brings it back with a fresh next run", async () => {
    h = await createApiHarness();
    const s = await create(h);
    const del = ScheduleDeleteResponseSchema.parse((await h.del(`/schedules/${s.id}`)).json());
    expect(Date.parse(del.undoUntil) - Date.parse(del.deletedAt)).toBe(6000);
    expect(SchedulesResponseSchema.parse((await h.get("/schedules")).json()).schedules).toEqual([]);
    expect((await h.get(`/schedules/${s.id}`)).statusCode).toBe(404);
    h.t.clock.advance(5000);
    const restored = await h.post(`/schedules/${s.id}/restore`);
    expect(restored.statusCode).toBe(200);
    expect(ScheduleViewSchema.parse(restored.json())).toMatchObject({ id: s.id, deletedAt: null, nextRunAt: computeNextRunAt(s.cron, s.timezone, h.t.clock.now()) });
    expect((await h.post(`/schedules/${s.id}/restore`)).statusCode).toBe(409);
  });

  it("restore after the undo window is refused and the schedule is purged", async () => {
    h = await createApiHarness();
    const s = await create(h);
    await h.del(`/schedules/${s.id}`);
    h.t.clock.advance(7000);
    const late = await h.post(`/schedules/${s.id}/restore`);
    expect(late.statusCode).toBe(409);
    expect(late.json().error.details).toEqual({ reason: "undo_window_passed" });
    expect(getSchedule(h.t.db, Number(s.id), { includeDeleted: true })).toBeUndefined();
    expect((await h.del(`/schedules/${s.id}`)).statusCode).toBe(404);
  });

  it("run now starts the scan; a second one while it scans answers overlap; the row shows the last result", async () => {
    h = await createApiHarness();
    h.t.runner.script({ bot: "research", kind: "scan", times: 1, delayMs: 60_000 });
    const s = await create(h);
    const first = ScheduleRunNowResponseSchema.parse((await h.post(`/schedules/${s.id}/run`)).json());
    expect(first).toMatchObject({ started: true, runId: expect.any(String) });
    await h.t.flush();
    expect(ScheduleRunNowResponseSchema.parse((await h.post(`/schedules/${s.id}/run`)).json())).toEqual({ started: false, reason: "overlap" });
    expect(ScheduleViewSchema.parse((await h.get(`/schedules/${s.id}`)).json()).lastResult).toMatch(/scanning/);
    h.t.clock.advance(60_000);
    await h.t.idle();
    const view = ScheduleViewSchema.parse((await h.get(`/schedules/${s.id}`)).json());
    expect(view.lastRunId).toBe(first.started ? first.runId : null);
    expect(view.lastResult).toMatch(/^\w{3} \d{1,2} \w{3} · 1 to review$/);
    expect((await h.post("/schedules/999/run")).statusCode).toBe(404);
  });
});
