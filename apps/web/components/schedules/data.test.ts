import { ScheduleViewSchema, type ScheduleCreateRequest } from "@bs-job-agents/shared";
import { searchProfileFixture } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import { mockNextRunAt } from "@/lib/api/mock/routes";
import { TEST_NOW, testMock } from "@/lib/api/mock/testing";
import { apiErrorInfo } from "./apiError";
import { createSchedulesData, profileOptions } from "./data";

// Sunday 11 Oct 2026, 10:00 in Vietnam.
const NOW = TEST_NOW;
const EVENING: ScheduleCreateRequest = {
  name: "Evening",
  cron: "0 19 * * *",
  timezone: "Asia/Ho_Chi_Minh",
  workflowName: "job-scan",
  searchProfileId: null,
  params: {},
  enabled: true,
};

describe("the mock's next run (Asia/Ho_Chi_Minh)", () => {
  it("finds the next weekday, daily and weekly slot", () => {
    expect(mockNextRunAt("0 9 * * 1-5", NOW)).toBe("2026-10-12T02:00:00.000Z"); // Mon 09:00
    expect(mockNextRunAt("30 18 * * *", NOW)).toBe("2026-10-11T11:30:00.000Z"); // today 18:30
    expect(mockNextRunAt("0 9 * * *", NOW)).toBe("2026-10-12T02:00:00.000Z"); // 09:00 already passed today
    expect(mockNextRunAt("0 7 * * 0", NOW)).toBe("2026-10-18T00:00:00.000Z"); // next Sunday 07:00
    expect(mockNextRunAt("15 9 1 * *", NOW)).toBeNull();
  });
});

describe("schedules adapter", () => {
  it("lists the seeded weekday scan", async () => {
    const rows = await createSchedulesData(testMock()).list();
    expect(rows.map((r) => r.name)).toEqual(["Weekday morning scan"]);
  });

  it("creates with a next run, updates, soft-deletes and restores", async () => {
    const data = createSchedulesData(testMock());
    const created = ScheduleViewSchema.parse(await data.create(EVENING));
    expect(created).toMatchObject({ nextRunAt: "2026-10-11T12:00:00.000Z", lastResult: null, deletedAt: null });

    const updated = await data.update(created.id, { enabled: false });
    expect(updated).toMatchObject({ enabled: false, nextRunAt: null });

    const del = await data.remove(created.id);
    expect(Date.parse(del.undoUntil) - Date.parse(del.deletedAt)).toBe(6000);
    expect((await data.list()).map((r) => r.id)).toEqual(["sch_1"]);

    await data.restore(created.id);
    expect((await data.list()).map((r) => r.id)).toEqual(["sch_1", created.id]);
  });

  it("refuses a restore after the 6 s undo window (409 undo_window_passed), and the schedule is gone", async () => {
    let t = NOW.getTime();
    const data = createSchedulesData(testMock({ now: () => t }));
    await data.remove("sch_1");
    t += 6_001;
    const late = await data.restore("sch_1").catch((e: unknown) => e);
    expect(apiErrorInfo(late)).toMatchObject({ status: 409, code: "conflict", reason: "undo_window_passed" });
    expect(await data.list()).toEqual([]);
  });

  it("rejects invalid requests like the API (400), and unknown ids (404)", async () => {
    const data = createSchedulesData(testMock());
    expect(apiErrorInfo(await data.update("sch_1", { cron: "0 9 * *" }).catch((e: unknown) => e))).toMatchObject({ status: 400, code: "validation_failed" });
    expect(apiErrorInfo(await data.create({ ...EVENING, workflowName: "apply-to-link" }).catch((e: unknown) => e))).toMatchObject({ status: 400 });
    expect(apiErrorInfo(await data.update("nope", { enabled: true }).catch((e: unknown) => e))).toMatchObject({ status: 404, code: "not_found" });
  });

  it("Run now starts a job-scan with the schedule trigger, then refuses to overlap it", async () => {
    const mock = testMock();
    const data = createSchedulesData(mock);
    const first = await data.runNow("sch_1");
    expect(first).toEqual({ started: true, runId: "13" });
    expect((await mock.getRun("13")).run).toMatchObject({ workflowName: "job-scan", trigger: "schedule", scheduleId: "sch_1" });
    expect(await data.runNow("sch_1")).toEqual({ started: false, reason: "overlap" });
    await mock.idle();
  });

  it("offers the active Search Profile as the default criteria, then other profiles", async () => {
    expect(await createSchedulesData(testMock()).profiles()).toEqual([{ id: null, label: "Default (v3)" }]);
    const other = { ...searchProfileFixture, id: "9", name: "Remote only", active: false, version: 2 };
    expect(profileOptions([searchProfileFixture, other])).toEqual([
      { id: null, label: "Default (v3)" },
      { id: "9", label: "Remote only (v2)" },
    ]);
    expect(profileOptions([])).toEqual([{ id: null, label: "Active criteria" }]);
  });
});
