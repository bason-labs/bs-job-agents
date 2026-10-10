import { CriteriaUpdateRequestSchema, type SearchProfile } from "@bs-job-agents/shared";
import { searchProfileFixture } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import {
  SALARY_POLICY_OPTIONS,
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
