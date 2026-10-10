import { describe, expect, it } from "vitest";
import { createFixtureCriteriaData } from "@/components/criteria/data";
import { createFixtureSchedulesData, fixtureNextRun } from "./data";

// Sunday 11 Oct 2026, 10:00 in Vietnam.
const NOW = new Date("2026-10-11T03:00:00Z");
const make = () => createFixtureSchedulesData({ now: () => NOW, criteria: createFixtureCriteriaData() });

describe("fixtureNextRun (Asia/Ho_Chi_Minh)", () => {
  it("finds the next weekday, daily and weekly slot", () => {
    expect(fixtureNextRun("0 9 * * 1-5", NOW)).toBe("2026-10-12T02:00:00.000Z"); // Mon 09:00
    expect(fixtureNextRun("30 18 * * *", NOW)).toBe("2026-10-11T11:30:00.000Z"); // today 18:30
    expect(fixtureNextRun("0 9 * * *", NOW)).toBe("2026-10-12T02:00:00.000Z"); // 09:00 already passed today
    expect(fixtureNextRun("0 7 * * 0", NOW)).toBe("2026-10-18T00:00:00.000Z"); // next Sunday 07:00
    expect(fixtureNextRun("15 9 1 * *", NOW)).toBeNull();
  });
});

describe("fixture schedules store", () => {
  it("lists the seeded weekday scan", async () => {
    const rows = await make().list();
    expect(rows.map((r) => r.name)).toEqual(["Weekday morning scan"]);
  });

  it("creates with a next run, updates, soft-deletes and restores", async () => {
    const data = make();
    const created = await data.create({
      name: "Evening",
      cron: "0 19 * * *",
      timezone: "Asia/Ho_Chi_Minh",
      workflowName: "job-scan",
      searchProfileId: null,
      params: {},
      enabled: true,
    });
    expect(created).toMatchObject({ id: "sch_2", nextRunAt: "2026-10-11T12:00:00.000Z", lastResult: null, deletedAt: null });

    const updated = await data.update("sch_2", { enabled: false });
    expect(updated).toMatchObject({ enabled: false, nextRunAt: null });

    const del = await data.remove("sch_2");
    expect(Date.parse(del.undoUntil) - Date.parse(del.deletedAt)).toBe(6000);
    expect((await data.list()).map((r) => r.id)).toEqual(["sch_1"]);

    await data.restore("sch_2");
    expect((await data.list()).map((r) => r.id)).toEqual(["sch_1", "sch_2"]);
  });

  it("rejects invalid requests like the API would", async () => {
    const data = make();
    await expect(data.update("sch_1", { cron: "0 9 * *" })).rejects.toThrow();
    await expect(data.update("nope", { enabled: true })).rejects.toThrow(/not found/);
  });

  it("starts a run, then refuses to overlap it", async () => {
    const data = make();
    expect(await data.runNow("sch_1")).toEqual({ started: true, runId: "run_14" });
    expect(await data.runNow("sch_1")).toEqual({ started: false, reason: "overlap" });
  });

  it("offers the active Search Profile as the default criteria", async () => {
    expect(await make().profiles()).toEqual([{ id: null, label: "Default (v3)" }]);
  });
});

describe("fixture criteria store", () => {
  it("saves a new active version and keeps the history newest first", async () => {
    const data = createFixtureCriteriaData(undefined, () => new Date("2026-10-11T03:00:00Z"));
    const current = await data.get();
    const { id: _id, name: _name, version: _v, active: _a, updatedAt: _u, ...fields } = current;
    const saved = await data.save({ ...fields, roles: [...fields.roles, "Fullstack Engineer"] });
    expect(saved).toMatchObject({ version: 4, active: true, updatedAt: "2026-10-11T03:00:00.000Z" });
    expect(saved.roles).toContain("Fullstack Engineer");
    expect((await data.versions()).versions.map((v) => [v.version, v.active])).toEqual([
      [4, true],
      [3, false],
      [2, false],
      [1, false],
    ]);
  });

  it("rejects a profile without roles (UC-21b b)", async () => {
    const data = createFixtureCriteriaData();
    const { id: _id, name: _name, version: _v, active: _a, updatedAt: _u, ...fields } = await data.get();
    await expect(data.save({ ...fields, roles: [] })).rejects.toThrow(/role/);
  });
});
