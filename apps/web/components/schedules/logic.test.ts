import { ScheduleCreateRequestSchema, ScheduleUpdateRequestSchema, type ScheduleView } from "@bs-job-agents/shared";
import { describe, expect, it } from "vitest";
import {
  cronLabel,
  cronToRepeat,
  formToCreateRequest,
  formToCron,
  formToUpdateRequest,
  newScheduleForm,
  repeatLabel,
  scheduleSummary,
  scheduleToForm,
  validateScheduleForm,
  type ScheduleForm,
} from "./logic";

const view = (over: Partial<ScheduleView> = {}): ScheduleView => ({
  id: "sch_1",
  name: "Weekday morning scan",
  cron: "0 9 * * 1-5",
  timezone: "Asia/Ho_Chi_Minh",
  workflowName: "job-scan",
  searchProfileId: null,
  params: {},
  enabled: true,
  lastRunId: "run_12",
  nextRunAt: "2026-10-12T09:00:00+07:00",
  deletedAt: null,
  lastResult: "Fri 9 Oct · 3 to review",
  ...over,
});

const form = (over: Partial<ScheduleForm> = {}): ScheduleForm => ({ ...newScheduleForm(), name: "Morning", ...over });

describe("new schedule defaults (spec §15.2: weekdays 09:00)", () => {
  it("starts as an enabled weekday 09:00 scan on the active criteria", () => {
    expect(newScheduleForm()).toEqual({
      name: "",
      freq: "weekdays",
      time: "09:00",
      day: "Mon",
      cron: "0 9 * * 1-5",
      searchProfileId: null,
      enabled: true,
    });
  });
});

describe("cronToRepeat: the modal's Repeat options from a stored cron", () => {
  it("reads weekdays, daily and weekly crons on a 30-minute slot", () => {
    expect(cronToRepeat("0 9 * * 1-5")).toEqual({ freq: "weekdays", time: "09:00", day: "Mon", cron: "0 9 * * 1-5" });
    expect(cronToRepeat("30 18 * * *")).toEqual({ freq: "daily", time: "18:30", day: "Mon", cron: "30 18 * * *" });
    expect(cronToRepeat("0 7 * * 3")).toEqual({ freq: "weekly", time: "07:00", day: "Wed", cron: "0 7 * * 3" });
    expect(cronToRepeat("0 7 * * 0").day).toBe("Sun");
    expect(cronToRepeat("0 7 * * 7").day).toBe("Sun");
  });

  it("falls back to Custom for anything the simple options can't express", () => {
    for (const cron of ["15 9 * * 1-5", "0 9 1 * *", "0 9 * * 1,3", "0 */2 * * *", "0 9 * 10 *"]) {
      expect(cronToRepeat(cron)).toMatchObject({ freq: "custom", cron });
    }
  });
});

describe("formToCron (shared repeatToCron)", () => {
  it("builds the cron for each Repeat option", () => {
    expect(formToCron(form({ freq: "weekdays", time: "09:00" }))).toBe("0 9 * * 1-5");
    expect(formToCron(form({ freq: "daily", time: "18:30" }))).toBe("30 18 * * *");
    expect(formToCron(form({ freq: "weekly", time: "07:00", day: "Wed" }))).toBe("0 7 * * 3");
    expect(formToCron(form({ freq: "custom", cron: "  15 9 * * 1-5 " }))).toBe("15 9 * * 1-5");
  });

  it("round-trips through scheduleToForm", () => {
    for (const cron of ["0 9 * * 1-5", "30 18 * * *", "0 7 * * 3", "15 9 * * 1-5"]) {
      expect(formToCron(scheduleToForm(view({ cron })))).toBe(cron);
    }
  });
});

describe("labels (prototype schedLabel)", () => {
  it("names the repeat the way the prototype does", () => {
    expect(repeatLabel(form({ freq: "weekdays", time: "09:00" }))).toBe("Weekdays 09:00");
    expect(repeatLabel(form({ freq: "daily", time: "18:30" }))).toBe("Daily 18:30");
    expect(repeatLabel(form({ freq: "weekly", time: "07:00", day: "Wed" }))).toBe("Every Wed 07:00");
    expect(repeatLabel(form({ freq: "custom", cron: "15 9 * * 1-5" }))).toBe("cron: 15 9 * * 1-5");
    expect(cronLabel("0 9 * * 1-5")).toBe("Weekdays 09:00");
  });

  it("summarises a row: repeat · criteria · next · last", () => {
    expect(scheduleSummary(view(), "Default (v3)")).toBe(
      "Weekdays 09:00 · criteria Default (v3) · next: Mon 12 Oct, 09:00 · last: Fri 9 Oct · 3 to review",
    );
    expect(scheduleSummary(view({ lastResult: null, nextRunAt: null }), "Default (v3)")).toBe(
      "Weekdays 09:00 · criteria Default (v3) · next: — · last: —",
    );
    expect(scheduleSummary(view({ enabled: false }), "Default (v3)")).toContain("next: off");
  });
});

describe("validateScheduleForm (spec §11: name required, cron must have 5 fields)", () => {
  it("accepts a named schedule", () => {
    expect(validateScheduleForm(form())).toEqual({});
  });

  it("requires a name, with the prototype's copy", () => {
    expect(validateScheduleForm(form({ name: "   " }))).toEqual({ name: "Give the schedule a name" });
  });

  it("requires 5 cron fields for Custom only", () => {
    expect(validateScheduleForm(form({ freq: "custom", cron: "0 9 * *" }))).toEqual({ cron: "Cron needs 5 fields, e.g. 0 9 * * 1-5" });
    expect(validateScheduleForm(form({ freq: "custom", cron: "" }))).toEqual({ cron: "Cron needs 5 fields, e.g. 0 9 * * 1-5" });
    expect(validateScheduleForm(form({ freq: "weekdays", cron: "junk" }))).toEqual({});
  });
});

describe("requests for the schedules API", () => {
  it("creates a job-scan schedule in Asia/Ho_Chi_Minh that the shared schema accepts", () => {
    const req = formToCreateRequest(form({ name: "  Morning  ", freq: "weekly", day: "Fri", time: "08:30", enabled: false }));
    expect(req).toEqual({
      name: "Morning",
      cron: "30 8 * * 5",
      timezone: "Asia/Ho_Chi_Minh",
      workflowName: "job-scan",
      searchProfileId: null,
      params: {},
      enabled: false,
    });
    expect(ScheduleCreateRequestSchema.parse(req)).toEqual(req);
  });

  it("updates name, cron, profile and enabled", () => {
    const req = formToUpdateRequest(form({ name: "Evening", freq: "daily", time: "19:00", searchProfileId: "sp_ai" }));
    expect(req).toEqual({ name: "Evening", cron: "0 19 * * *", searchProfileId: "sp_ai", enabled: true });
    expect(ScheduleUpdateRequestSchema.parse(req)).toEqual(req);
  });
});
