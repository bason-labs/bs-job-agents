import { ApiErrorSchema, CriteriaResponseSchema, CriteriaVersionsResponseSchema, SEARCH_PROFILE_DEFAULTS } from "@bs-job-agents/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createApiHarness, type ApiHarness } from "../testing.js";

let h: ApiHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const fields = {
  ...SEARCH_PROFILE_DEFAULTS,
  workModes: [...SEARCH_PROFILE_DEFAULTS.workModes],
  seniority: [...SEARCH_PROFILE_DEFAULTS.seniority],
  sources: ["topcv", "itviec"],
  includeKeywords: ["React"],
  excludeKeywords: [],
  excludeCompanies: [],
  companyTypes: ["product"],
  languages: ["en"],
  roles: ["Frontend Engineer", "Software Engineer (React/Node)"],
  locations: ["Ho Chi Minh City", "Đà Nẵng"],
  minSalary: 25_000_000,
  currency: "VND",
};

describe("search criteria (UC-21b, §7.5)", () => {
  it("GET /criteria is the active profile; 404 before the first one exists", async () => {
    h = await createApiHarness();
    const res = await h.get("/criteria");
    expect(res.statusCode).toBe(200);
    expect(CriteriaResponseSchema.parse(res.json())).toMatchObject({ version: 1, active: true, roles: ["Frontend Engineer"] });
    await h.close();
    h = await createApiHarness({ engine: { noProfile: true } });
    expect((await h.get("/criteria")).statusCode).toBe(404);
  });

  it("PUT /criteria saves a new active version; the versions list says which is active", async () => {
    h = await createApiHarness();
    const res = await h.put("/criteria", fields);
    expect(res.statusCode).toBe(200);
    const saved = CriteriaResponseSchema.parse(res.json());
    expect(saved).toMatchObject({ version: 2, active: true, locations: ["Ho Chi Minh City", "Đà Nẵng"], minSalary: 25_000_000, currency: "VND" });
    expect(CriteriaResponseSchema.parse((await h.get("/criteria")).json()).version).toBe(2);
    const versions = CriteriaVersionsResponseSchema.parse((await h.get("/criteria/versions")).json()).versions;
    expect(versions.map((v) => [v.version, v.active])).toEqual([
      [2, true],
      [1, false],
    ]);
  });

  it("the first save creates the profile", async () => {
    h = await createApiHarness({ engine: { noProfile: true } });
    const res = await h.put("/criteria", fields);
    expect(res.statusCode).toBe(200);
    expect(CriteriaResponseSchema.parse(res.json())).toMatchObject({ version: 1, active: true });
    expect(CriteriaVersionsResponseSchema.parse((await h.get("/criteria/versions")).json()).versions).toHaveLength(1);
  });

  it("validates: one role, location and source at least; a salary needs a currency; fixed needs an amount", async () => {
    h = await createApiHarness();
    const noRoles = await h.put("/criteria", { ...fields, roles: [] });
    expect(noRoles.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(noRoles.json()).error.message).toMatch(/roles: at least one role is required/);
    expect((await h.put("/criteria", { ...fields, currency: null })).statusCode).toBe(400);
    expect((await h.put("/criteria", { ...fields, salaryPolicy: "fixed", salaryAmount: null })).statusCode).toBe(400);
    expect(CriteriaResponseSchema.parse((await h.get("/criteria")).json()).version).toBe(1);
  });
});
