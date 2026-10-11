// W4a (§7.5 search profile → each board's search URL; the skills give Research the same rules).
import { describe, expect, it } from "vitest";
import { SEARCH_PROFILE_DEFAULTS } from "@bs-job-agents/shared";
import { scanJobLimit, searchUrls, SOURCE_ADAPTERS } from "./sources.js";

const criteria = {
  ...SEARCH_PROFILE_DEFAULTS,
  workModes: [...SEARCH_PROFILE_DEFAULTS.workModes],
  seniority: [...SEARCH_PROFILE_DEFAULTS.seniority],
  sources: [...SEARCH_PROFILE_DEFAULTS.sources],
  languages: [...SEARCH_PROFILE_DEFAULTS.languages],
  includeKeywords: [],
  excludeKeywords: [],
  excludeCompanies: [],
  companyTypes: [],
  roles: ["Frontend Engineer"],
  locations: ["Ho Chi Minh City"],
};

describe("searchUrls", () => {
  it("TopCV: /tim-viec-lam-<role>-tai-<city>-kl<id> (observed 2026-10)", () => {
    expect(searchUrls("topcv", criteria)).toEqual(["https://www.topcv.vn/tim-viec-lam-frontend-engineer-tai-ho-chi-minh-kl2"]);
    expect(searchUrls("topcv", { ...criteria, locations: ["Hà Nội", "Đà Nẵng"] })).toEqual([
      "https://www.topcv.vn/tim-viec-lam-frontend-engineer-tai-ha-noi-kl1",
      "https://www.topcv.vn/tim-viec-lam-frontend-engineer-tai-da-nang-kl8",
    ]);
    expect(searchUrls("topcv", { ...criteria, locations: ["Remote (VN)"] })).toEqual(["https://www.topcv.vn/tim-viec-lam-frontend-engineer"]);
  });

  it("ITviec: /it-jobs/<role>/<city>", () => {
    expect(searchUrls("itviec", { ...criteria, roles: ["Frontend Engineer", "React Developer"] })).toEqual([
      "https://itviec.com/it-jobs/frontend-engineer/ho-chi-minh-hcm",
      "https://itviec.com/it-jobs/react-developer/ho-chi-minh-hcm",
    ]);
  });

  it("LinkedIn: the public job search, past week, with the work-mode filter when not all modes are wanted", () => {
    expect(searchUrls("linkedin", criteria)).toEqual([
      "https://www.linkedin.com/jobs/search?keywords=Frontend+Engineer&location=Ho+Chi+Minh+City%2C+Vietnam&f_TPR=r604800",
    ]);
    expect(searchUrls("linkedin", { ...criteria, locations: ["Remote (VN)"], workModes: ["remote"] })).toEqual([
      "https://www.linkedin.com/jobs/search?keywords=Frontend+Engineer&location=Vietnam&f_TPR=r604800&f_WT=2",
    ]);
  });

  it("caps the number of searches per scan", () => {
    const many = { ...criteria, roles: ["a1", "b2", "c3", "d4"], locations: ["HCM", "Hà Nội", "Đà Nẵng"] };
    expect(searchUrls("itviec", many)).toHaveLength(6);
  });

  it("a career site has no search URL (the task names the page)", () => {
    expect(searchUrls("career_site", criteria)).toEqual([]);
  });
});

describe("scanJobLimit", () => {
  it("is 3 × maxJobs (fit filtering keeps the top maxJobs later), at most 30", () => {
    expect(scanJobLimit(5)).toBe(15);
    expect(scanJobLimit(1)).toBe(3);
    expect(scanJobLimit(20)).toBe(30);
  });
});

describe("SOURCE_ADAPTERS", () => {
  it("names the four sources with their hosts", () => {
    expect(Object.keys(SOURCE_ADAPTERS).sort()).toEqual(["career_site", "itviec", "linkedin", "topcv", "upwork", "vietnamworks", "wellfound"]);
    expect(SOURCE_ADAPTERS.linkedin).toMatchObject({ displayName: "LinkedIn", hosts: ["linkedin.com"], maxPageViews: 40, minDelayMs: 3000, maxDelayMs: 8000 });
    expect(SOURCE_ADAPTERS.topcv.maxPageViews).toBeNull();
  });
});
