// W4a (UC-03, UC-04, §12 source adapters): the pure normalisers the parsers and the scan checker
// share — salary text, locations, posting dates and canonical URLs, incl. the Vietnamese formats.
import { describe, expect, it } from "vitest";
import { foldText } from "./text.js";
import { parseSalary } from "./salary.js";
import { locationMatches, normaliseLocation } from "./location.js";
import { parsePostedDate } from "./posted-date.js";
import { canonicalJobUrl, sourceOfUrl } from "./canonical-url.js";

describe("foldText", () => {
  it("drops Vietnamese diacritics (incl. đ) and case", () => {
    expect(foldText("Hồ Chí Minh")).toBe("ho chi minh");
    expect(foldText("Đà Nẵng")).toBe("da nang");
    expect(foldText("  Thoả   thuận ")).toBe("thoa thuan");
  });
});

describe("parseSalary", () => {
  const vnd = (min: number | null, max: number | null) => ({ min, max, currency: "VND", negotiable: false });
  const usd = (min: number | null, max: number | null) => ({ min, max, currency: "USD", negotiable: false });

  it.each([
    ["15 - 25 triệu", vnd(15_000_000, 25_000_000)],
    ["25–35 triệu", vnd(25_000_000, 35_000_000)],
    ["20 - 30 triệu VND", vnd(20_000_000, 30_000_000)],
    ["Tới 30 triệu", vnd(null, 30_000_000)],
    ["Lên đến 40 triệu", vnd(null, 40_000_000)],
    ["Trên 20 triệu", vnd(20_000_000, null)],
    ["Từ 18 triệu", vnd(18_000_000, null)],
    ["12,5 - 18 triệu", vnd(12_500_000, 18_000_000)],
    ["20tr - 30tr", vnd(20_000_000, 30_000_000)],
    ["20.000.000 - 30.000.000 đ", vnd(20_000_000, 30_000_000)],
    ["25,000,000 VND", vnd(25_000_000, 25_000_000)],
    ["Up to $2,000", usd(null, 2_000)],
    ["$1,000 - $3,000", usd(1_000, 3_000)],
    ["1,000 - 3,000 USD", usd(1_000, 3_000)],
    ["2,000–2,800 USD", usd(2_000, 2_800)],
    ["1500-2500$", usd(1_500, 2_500)],
    ["From 1,200 USD", usd(1_200, null)],
    ["Up to 2.5k USD", usd(null, 2_500)],
  ])("%s", (text, expected) => {
    expect(parseSalary(text)).toEqual(expected);
  });

  it.each(["Thỏa thuận", "Thoả thuận", "Negotiable", "Cạnh tranh", "Competitive"])("%s is negotiable", (text) => {
    expect(parseSalary(text)).toEqual({ min: null, max: null, currency: null, negotiable: true });
  });

  it("hidden or missing salaries are null, not invented", () => {
    expect(parseSalary(null)).toBeNull();
    expect(parseSalary("")).toBeNull();
    expect(parseSalary("Sign in to view salary")).toBeNull();
    expect(parseSalary("Đăng nhập để xem mức lương")).toBeNull();
    expect(parseSalary("very good")).toBeNull();
  });

  it("a bare number without a currency keeps the currency unknown", () => {
    expect(parseSalary("15 - 25")).toEqual({ min: 15, max: 25, currency: null, negotiable: false });
  });
});

describe("normaliseLocation", () => {
  it.each([
    ["Hồ Chí Minh", ["Ho Chi Minh City"]],
    ["TP.HCM", ["Ho Chi Minh City"]],
    ["HCM", ["Ho Chi Minh City"]],
    ["Ho Chi Minh City Metropolitan Area", ["Ho Chi Minh City"]],
    ["Sài Gòn", ["Ho Chi Minh City"]],
    ["Hà Nội", ["Hanoi"]],
    ["Ha Noi", ["Hanoi"]],
    ["Đà Nẵng", ["Da Nang"]],
    ["Danang", ["Da Nang"]],
    ["Ho Chi Minh - Ha Noi", ["Ho Chi Minh City", "Hanoi"]],
    ["Hồ Chí Minh: Phường Bình Thạnh (quận Bình Thạnh cũ)", ["Ho Chi Minh City"]],
  ])("%s", (text, cities) => {
    expect(normaliseLocation(text).cities).toEqual(cities);
  });

  it("detects remote work and keeps unknown places as written", () => {
    expect(normaliseLocation("Remote (VN)")).toEqual({ cities: [], remote: true, other: [] });
    expect(normaliseLocation("Làm việc từ xa").remote).toBe(true);
    expect(normaliseLocation("Bình Dương")).toEqual({ cities: [], remote: false, other: ["Bình Dương"] });
  });

  it("matches a job's location against the search profile's locations", () => {
    expect(locationMatches("Hồ Chí Minh", ["Ho Chi Minh City"])).toBe(true);
    expect(locationMatches("Hà Nội", ["Ho Chi Minh City", "Remote (VN)"])).toBe(false);
    expect(locationMatches("Remote", ["Remote (VN)"])).toBe(true);
    expect(locationMatches("Bình Dương", ["Bình Dương"])).toBe(true);
  });
});

describe("parsePostedDate", () => {
  const now = new Date("2026-10-11T10:00:00+07:00");
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();

  it.each([
    ["2 ngày trước", daysAgo(2)],
    ["Đăng 3 ngày trước", daysAgo(3)],
    ["Đăng 1 tuần trước", daysAgo(7)],
    ["1 tháng trước", daysAgo(30)],
    ["Hôm qua", daysAgo(1)],
    ["Hôm nay", daysAgo(0)],
    ["Posted 10 days ago", daysAgo(10)],
    ["5 days ago", daysAgo(5)],
    ["a day ago", daysAgo(1)],
    ["2 weeks ago", daysAgo(14)],
    ["30+ days ago", daysAgo(30)],
    ["yesterday", daysAgo(1)],
  ])("%s", (text, iso) => {
    expect(parsePostedDate(text, now)).toBe(iso);
  });

  it("hours and minutes ago", () => {
    expect(parsePostedDate("3 giờ trước", now)).toBe(new Date(now.getTime() - 3 * 3_600_000).toISOString());
    expect(parsePostedDate("45 minutes ago", now)).toBe(new Date(now.getTime() - 45 * 60_000).toISOString());
  });

  it("absolute dates: ISO and Vietnamese dd/mm/yyyy, at Vietnam midnight", () => {
    expect(parsePostedDate("2026-10-05", now)).toBe("2026-10-04T17:00:00.000Z");
    expect(parsePostedDate("05/10/2026", now)).toBe("2026-10-04T17:00:00.000Z");
    expect(parsePostedDate("2026-10-08T09:00:00+07:00", now)).toBe("2026-10-08T02:00:00.000Z");
  });

  it("unknown text is null (never guessed)", () => {
    expect(parsePostedDate(null, now)).toBeNull();
    expect(parsePostedDate("Ứng tuyển", now)).toBeNull();
    expect(parsePostedDate("31/02/2026", now)).toBeNull();
  });
});

describe("canonicalJobUrl", () => {
  it.each([
    [
      "https://www.topcv.vn/viec-lam/senior-developer-nodejs-reactjs-ai/2316742.html?ta_source=JobSearchList_LinkDetail&u_sr_id=abc",
      "https://www.topcv.vn/viec-lam/senior-developer-nodejs-reactjs-ai/2316742.html",
    ],
    ["http://topcv.vn/viec-lam/x/123.html#apply", "https://www.topcv.vn/viec-lam/x/123.html"],
    ["https://www.topcv.vn/brand/acme/tuyen-dung/dev-react-j2330001.html?ta_source=x", "https://www.topcv.vn/brand/acme/tuyen-dung/dev-react-j2330001.html"],
    ["https://itviec.com/it-jobs/frontend-engineer-reactjs-hubble-pte-ltd-0532?lab_feature=preview_jd_page", "https://itviec.com/it-jobs/frontend-engineer-reactjs-hubble-pte-ltd-0532"],
    ["https://itviec.com/it-jobs/frontend-engineer-reactjs-hubble-pte-ltd-0532/content?job_index=2&locale=en", "https://itviec.com/it-jobs/frontend-engineer-reactjs-hubble-pte-ltd-0532"],
    [
      "https://vn.linkedin.com/jobs/view/senior-frontend-developer-at-astek-vietnam-4472144344?position=1&pageNum=0&refId=x&trackingId=y",
      "https://www.linkedin.com/jobs/view/4472144344/",
    ],
    ["https://www.linkedin.com/jobs/view/4472144344", "https://www.linkedin.com/jobs/view/4472144344/"],
    ["https://www.linkedin.com/jobs/search/?currentJobId=4472144344&keywords=react", "https://www.linkedin.com/jobs/view/4472144344/"],
    ["https://job-boards.greenhouse.io/axon/jobs/7806690003?gh_src=abc&utm_source=x#app", "https://job-boards.greenhouse.io/axon/jobs/7806690003"],
    ["https://Careers.Example.com/jobs/42/?utm_medium=y&lang=en", "https://careers.example.com/jobs/42?lang=en"],
  ])("%s", (url, canonical) => {
    expect(canonicalJobUrl(url)).toBe(canonical);
  });

  it("is null for something that is not an http(s) URL", () => {
    expect(canonicalJobUrl("javascript:void(0)")).toBeNull();
    expect(canonicalJobUrl("not a url")).toBeNull();
  });

  it("knows which board a URL belongs to", () => {
    expect(sourceOfUrl("https://www.topcv.vn/viec-lam/x/1.html")).toBe("topcv");
    expect(sourceOfUrl("https://itviec.com/it-jobs/x")).toBe("itviec");
    expect(sourceOfUrl("https://vn.linkedin.com/jobs/view/1")).toBe("linkedin");
    expect(sourceOfUrl("https://evil-linkedin.com/jobs/view/1")).toBeNull();
    expect(sourceOfUrl("https://job-boards.greenhouse.io/axon/jobs/1")).toBeNull();
  });
});
