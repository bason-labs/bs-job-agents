import { CriteriaUpdateRequestSchema, type SearchProfile } from "@bs-job-agents/shared";
import { searchProfileFixture } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import {
  BLANK_FORM,
  SALARY_POLICY_OPTIONS,
  SOURCE_GROUP_OPTIONS,
  SOURCE_OPTIONS,
  showsTimezoneOverlap,
  addChip,
  formToRequest,
  isDirty,
  profileHeader,
  profileToForm,
  removeChip,
  toggleValue,
  validateCriteria,
  type CriteriaForm,
} from "./logic";

const profile: SearchProfile = searchProfileFixture;
const form = (over: Partial<CriteriaForm> = {}): CriteriaForm => ({ ...profileToForm(profile), ...over });

describe("profileToForm / formToRequest", () => {
  it("keeps only the editable fields, and the request passes the shared schema", () => {
    const f = profileToForm(profile);
    expect(f).not.toHaveProperty("id");
    expect(f).not.toHaveProperty("version");
    expect(f.roles).toEqual(["Frontend Engineer", "Software Engineer (React/Node)"]);
    expect(CriteriaUpdateRequestSchema.safeParse(formToRequest(f)).success).toBe(true);
  });

  it("starts from the shared defaults before the first save; the header says the save creates v1", () => {
    const f = profileToForm(null);
    expect(f).toMatchObject({ roles: [], locations: [], sources: ["topcv", "itviec", "linkedin"], languages: ["en"], maxJobs: 5, fitThreshold: 60 });
    // Not saveable until Ba adds a role and a location (the shared rules).
    expect(CriteriaUpdateRequestSchema.safeParse(formToRequest(f)).success).toBe(false);
    expect(CriteriaUpdateRequestSchema.safeParse(formToRequest({ ...f, roles: ["Frontend Engineer"], locations: ["Ho Chi Minh City"] })).success).toBe(true);
    expect(isDirty(f, null)).toBe(false);
    expect(profileHeader(null, false)).toBe("No search criteria yet · saving creates v1");
  });

  it("defaults the currency to VND so amounts always have one (UC-21b b)", () => {
    expect(profileToForm({ ...profile, minSalary: null, currency: null }).currency).toBe("VND");
  });

  it("treats a zero fixed amount as missing", () => {
    expect(formToRequest(form({ salaryAmount: 0 })).salaryAmount).toBeNull();
  });
});

describe("chips", () => {
  it("adds a trimmed value once, case-insensitively", () => {
    expect(addChip(["React"], "  Next.js ")).toEqual(["React", "Next.js"]);
    expect(addChip(["React"], "react")).toEqual(["React"]);
    expect(addChip(["React"], "   ")).toEqual(["React"]);
  });

  it("removes by index", () => {
    expect(removeChip(["a", "b", "c"], 1)).toEqual(["a", "c"]);
  });

  it("toggles a value and keeps the canonical order", () => {
    const order = ["topcv", "itviec", "linkedin"] as const;
    expect(toggleValue(["linkedin"], "topcv", order)).toEqual(["topcv", "linkedin"]);
    expect(toggleValue(["topcv", "linkedin"], "topcv", order)).toEqual(["linkedin"]);
  });
});

describe("validateCriteria (UC-21b b, §7.5)", () => {
  it("accepts the fixture profile", () => {
    expect(validateCriteria(form())).toEqual({});
  });

  it("needs at least one role, location and source", () => {
    expect(validateCriteria(form({ roles: [], locations: [], sources: [] }))).toEqual({
      roles: "Add at least one role",
      locations: "Add at least one location",
      sources: "Pick at least one source",
    });
  });

  it("needs an amount for the fixed salary rule", () => {
    expect(validateCriteria(form({ salaryPolicy: "fixed", salaryAmount: null }))).toEqual({
      salaryAmount: "Enter the amount Apply should write",
    });
    expect(validateCriteria(form({ salaryPolicy: "fixed", salaryAmount: 30_000_000 }))).toEqual({});
    // Other rules don't need an amount.
    expect(validateCriteria(form({ salaryPolicy: "negotiable", salaryAmount: null }))).toEqual({});
  });
});

describe("W5 sources and the time-zone overlap", () => {
  it("groups every source: Vietnam boards, Remote boards, Global; new ones are off by default", () => {
    expect(SOURCE_GROUP_OPTIONS.map((g) => [g.label, g.options.map((o) => o.label)])).toEqual([
      ["Vietnam boards", ["TopCV", "ITviec", "VietnamWorks"]],
      ["Remote boards", ["Remote OK", "We Work Remotely", "Remotive", "Jobspresso"]],
      ["Global", ["LinkedIn", "Wellfound", "Upwork"]],
    ]);
    expect(SOURCE_OPTIONS).toHaveLength(10);
    expect(BLANK_FORM.sources).toEqual(["topcv", "itviec", "linkedin"]);
    // A saved list keeps the shared order whatever the group.
    expect(toggleValue(["topcv", "linkedin"], "remoteok", SOURCE_OPTIONS.map((o) => o.value))).toEqual(["topcv", "linkedin", "remoteok"]);
  });

  it("shows the overlap field only with a remote board on", () => {
    expect(showsTimezoneOverlap({ sources: ["topcv", "itviec", "linkedin", "vietnamworks"] })).toBe(false);
    expect(showsTimezoneOverlap({ sources: ["topcv", "remotive"] })).toBe(true);
    expect(showsTimezoneOverlap({ sources: ["upwork"] })).toBe(true);
  });

  it("sends the overlap trimmed, or null when empty, so an old profile is not dirty", () => {
    expect(formToRequest(form({ timezoneOverlap: "  UTC+7 ±3h " })).timezoneOverlap).toBe("UTC+7 ±3h");
    expect(formToRequest(form({ timezoneOverlap: "" })).timezoneOverlap).toBeNull();
    expect(isDirty(form({ timezoneOverlap: "" }), profile)).toBe(false);
    expect(isDirty(form({ timezoneOverlap: "Asia" }), profile)).toBe(true);
    expect(validateCriteria(form({ sources: ["remoteok"], timezoneOverlap: "somewhere" }))).toEqual({
      timezoneOverlap: "Use a region (Asia, APAC, Europe…) or a UTC offset with a window, e.g. UTC+7 ±3h",
    });
    expect(validateCriteria(form({ sources: ["remoteok"], timezoneOverlap: "Asia" }))).toEqual({});
  });
});

describe("dirty state and header", () => {
  it("is dirty only when a field differs from the saved profile", () => {
    expect(isDirty(form(), profile)).toBe(false);
    expect(isDirty(form({ fitThreshold: 65 }), profile)).toBe(true);
    expect(isDirty(form({ roles: [...profile.roles, "X"] }), profile)).toBe(true);
  });

  it("describes the active profile like the prototype", () => {
    expect(profileHeader(profile, false)).toBe("Active profile v3 · updated 2026-10-10");
    expect(profileHeader(profile, true)).toBe("Active profile v3 · updated just now");
  });

  it("labels the salary rules with the prototype copy", () => {
    expect(SALARY_POLICY_OPTIONS.map((o) => o.label)).toEqual([
      "Leave blank when optional",
      "Write “Negotiable / Thỏa thuận”",
      "Use a fixed amount",
      "Ask me each time",
    ]);
  });
});
