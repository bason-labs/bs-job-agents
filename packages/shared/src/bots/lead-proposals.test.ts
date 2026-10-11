import { describe, expect, it } from "vitest";
import { leadCriteriaProposalFixture, leadScheduleProposalFixture } from "../fixtures/bot-outputs.js";
import { SEARCH_PROFILE_DEFAULTS, type SearchProfileFieldsBase } from "../domain/search-profile.js";
import { getBotOutputJsonSchema, parseBotOutput } from "./registry.js";
import { LeadOutputSchema, type CriteriaChanges } from "./lead.js";
import { applyCriteriaChanges, criteriaChangeSentence, describeCriteriaChange, describeScheduleRepeat, scheduleProposalCron } from "./lead-proposals.js";

const base: SearchProfileFieldsBase = {
  ...SEARCH_PROFILE_DEFAULTS,
  workModes: [...SEARCH_PROFILE_DEFAULTS.workModes],
  seniority: [...SEARCH_PROFILE_DEFAULTS.seniority],
  sources: [...SEARCH_PROFILE_DEFAULTS.sources],
  includeKeywords: [],
  excludeKeywords: ["PHP"],
  excludeCompanies: [],
  companyTypes: [],
  languages: ["en"],
  roles: ["Frontend Engineer"],
  locations: ["Ho Chi Minh City"],
};
const none: CriteriaChanges = {
  roles: null,
  locations: null,
  includeKeywords: null,
  excludeKeywords: null,
  excludeCompanies: null,
  companyTypes: null,
  workModes: null,
  seniority: null,
  sources: null,
  minSalary: null,
  maxJobs: null,
  fitThreshold: null,
};

describe("LeadAction proposals (PM3 M3, S1)", () => {
  it("parses the proposal fixtures and keeps them in the strict JSON Schema", () => {
    expect(parseBotOutput("LeadOutput", leadCriteriaProposalFixture).success).toBe(true);
    expect(parseBotOutput("LeadOutput", leadScheduleProposalFixture).success).toBe(true);
    const json = JSON.stringify(getBotOutputJsonSchema("LeadOutput"));
    expect(json).toContain("propose_criteria_change");
    expect(json).toContain("propose_schedule");
  });

  it("refuses a schedule time that is not HH:MM, and unknown fields", () => {
    const bad = structuredClone(leadScheduleProposalFixture) as { actions: { schedule: { time: string } }[] };
    bad.actions[0]!.schedule.time = "9am";
    expect(LeadOutputSchema.safeParse(bad).success).toBe(false);
    const extra = structuredClone(leadCriteriaProposalFixture) as { actions: { changes: Record<string, unknown> }[] };
    extra.actions[0]!.changes.salaryPolicy = "fixed";
    expect(LeadOutputSchema.safeParse(extra).success).toBe(false);
  });
});

describe("applyCriteriaChanges / describeCriteriaChange", () => {
  it("adds and removes list items case-insensitively without duplicates", () => {
    const next = applyCriteriaChanges(base, { ...none, locations: { add: ["Đà Nẵng", "ho chi minh city"], remove: [] }, excludeKeywords: { add: [], remove: ["php"] } });
    expect(next.locations).toEqual(["Ho Chi Minh City", "Đà Nẵng"]);
    expect(next.excludeKeywords).toEqual([]);
    expect(describeCriteriaChange(base, next)).toEqual(["add Đà Nẵng to locations", "remove PHP from exclude keywords"]);
    expect(criteriaChangeSentence(describeCriteriaChange(base, next))).toBe("Add Đà Nẵng to locations; remove PHP from exclude keywords.");
  });

  it("replaces whole lists, sets or clears the salary floor, and numbers", () => {
    const next = applyCriteriaChanges(base, { ...none, sources: ["topcv", "itviec"], minSalary: { amount: 25_000_000, currency: "VND" }, maxJobs: 8, fitThreshold: 70 });
    expect(next).toMatchObject({ sources: ["topcv", "itviec"], minSalary: 25_000_000, currency: "VND", maxJobs: 8, fitThreshold: 70 });
    expect(describeCriteriaChange(base, next)).toEqual(["sources: TopCV, ITviec", "minimum salary 25,000,000 VND", "at most 8 jobs per scan", "fit threshold 70"]);
    const cleared = applyCriteriaChanges(next, { ...none, minSalary: { amount: null, currency: null } });
    expect(cleared.minSalary).toBeNull();
    expect(describeCriteriaChange(next, cleared)).toEqual(["no minimum salary"]);
  });

  it("a proposal that changes nothing describes nothing", () => {
    expect(describeCriteriaChange(base, applyCriteriaChanges(base, { ...none, locations: { add: ["HO CHI MINH CITY"], remove: [] } }))).toEqual([]);
  });
});

describe("schedule proposals", () => {
  it("turns repeat + time into cron and the row's summary", () => {
    const p = { name: "x", repeat: "weekdays", day: null, time: "09:00", searchProfileId: null } as const;
    expect(scheduleProposalCron(p)).toBe("0 9 * * 1-5");
    expect(describeScheduleRepeat(p)).toBe("Weekdays 09:00");
    expect(scheduleProposalCron({ ...p, repeat: "daily", time: "18:30" })).toBe("30 18 * * *");
    expect(scheduleProposalCron({ ...p, repeat: "weekly", day: "Mon" })).toBe("0 9 * * 1");
    expect(describeScheduleRepeat({ ...p, repeat: "weekly", day: "Mon" })).toBe("Weekly on Mon 09:00");
    expect(() => scheduleProposalCron({ ...p, repeat: "weekly", day: null })).toThrow(/day/);
  });
});
