import { describe, expect, it } from "vitest";
import { canonicalizeUrl, companyKey, jobDedupeHash, locationKey, normalizeText } from "./dedupe.js";

describe("canonicalizeUrl", () => {
  it("strips tracking params, fragment, www and trailing slash", () => {
    expect(
      canonicalizeUrl("http://www.TopCV.vn/viec-lam/frontend-developer/2298533.html/?ta_source=JobSearchList&utm_source=x#apply"),
    ).toBe("https://topcv.vn/viec-lam/frontend-developer/2298533.html");
  });

  it("keeps meaningful query params, sorted", () => {
    expect(canonicalizeUrl("https://careers.example.com/job?b=2&id=77&utm_medium=email&a=1")).toBe(
      "https://careers.example.com/job?a=1&b=2&id=77",
    );
  });

  it("collapses LinkedIn job links to /jobs/view/<id>", () => {
    expect(canonicalizeUrl("https://www.linkedin.com/jobs/view/4012345678/?refId=abc&trackingId=def&trk=x")).toBe(
      "https://linkedin.com/jobs/view/4012345678",
    );
    expect(canonicalizeUrl("https://vn.linkedin.com/jobs/view/senior-frontend-at-kite-labs-4012345678")).toBe(
      "https://linkedin.com/jobs/view/4012345678",
    );
    expect(canonicalizeUrl("https://www.linkedin.com/jobs/search/?currentJobId=4012345678&keywords=react")).toBe(
      "https://linkedin.com/jobs/view/4012345678",
    );
  });

  it("falls back to a trimmed lower-case string for non-URLs", () => {
    expect(canonicalizeUrl("  Not A URL ")).toBe("not a url");
  });
});

describe("normalisation", () => {
  it("removes Vietnamese diacritics and punctuation", () => {
    expect(normalizeText("Lập trình viên Frontend (ReactJS)")).toBe("lap trinh vien frontend reactjs");
    expect(normalizeText("Đà Nẵng")).toBe("da nang");
  });

  it("drops legal suffixes from company names", () => {
    expect(companyKey("Công ty TNHH Sao Việt Tech")).toBe("sao viet tech");
    expect(companyKey("NovaPay JSC.")).toBe("novapay");
    expect(companyKey("Kite Labs, Inc.")).toBe("kite labs");
  });

  it("maps city aliases", () => {
    expect(locationKey("TP. Hồ Chí Minh")).toBe("ho chi minh");
    expect(locationKey("HCM")).toBe("ho chi minh");
    expect(locationKey("Ho Chi Minh City")).toBe("ho chi minh");
    expect(locationKey("Hà Nội")).toBe("ha noi");
    expect(locationKey("Remote (VN)")).toBe("remote vn");
  });
});

describe("jobDedupeHash", () => {
  it("is stable across spelling variants of the same posting", () => {
    const a = jobDedupeHash({ company: "Công ty TNHH Sao Việt Tech", title: "Lập trình viên Frontend ReactJS", location: "TP. Hồ Chí Minh" });
    const b = jobDedupeHash({ company: "Sao Viet Tech", title: "Lap trinh vien frontend reactjs", location: "Ho Chi Minh City" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs when title or location differ", () => {
    const base = { company: "NovaPay", title: "Frontend Engineer", location: "HCM" };
    expect(jobDedupeHash(base)).not.toBe(jobDedupeHash({ ...base, title: "Backend Engineer" }));
    expect(jobDedupeHash(base)).not.toBe(jobDedupeHash({ ...base, location: "Hà Nội" }));
  });
});
