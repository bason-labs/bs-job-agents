import { describe, expect, it } from "vitest";
import { allowedNumbers, capitalisedNames, claimsIn, numbersIn, titlesIn, unsupportedClaims, type ClaimSource } from "./claims.js";

const claimNumbersIn = (t: string) => claimsIn(t).numbers;
const durationsIn = (t: string) => claimsIn(t).durations;
const monthsIn = (t: string) => claimsIn(t).months;

const src = (texts: string[], dates: string[] = []): ClaimSource => ({ texts, dates });

describe("numbers (moved from the fact-draft guard)", () => {
  it("reads digits with separators and number words, as before", () => {
    expect(numbersIn("1,000 users and 1.000 more, 40% faster, 007")).toEqual(["1000", "1000", "40", "7"]);
    expect([...allowedNumbers("Ba năm dùng AWS; three services")]).toEqual(["3"]);
    expect(capitalisedNames("Built a Next.js app. Used Docker and AWS. Led CI.")).toEqual(["Next.js", "Docker", "AWS", "CI"]);
  });

  it.each([
    ["six services", ["6"]],
    ["ten services", ["10"]],
    ["3+ engineers", ["3"]],
    ["40% faster", ["40"]],
    ["1,000 users", ["1000"]],
    ["10x faster", ["10"]],
    ["hai dịch vụ, ba người", ["2", "3"]],
    ["twelve teams, a dozen apps", ["12", "12"]],
  ])("claim numbers in %j", (text, numbers) => {
    expect(claimNumbersIn(text)).toEqual(numbers);
  });

  it("does not read digits inside names, Ba's name or articles as numbers", () => {
    expect(claimNumbersIn("EC2, S3, K8s, HTML5, OAuth2")).toEqual([]);
    expect(claimNumbersIn("Ba triển khai một ứng dụng")).toEqual([]);
    expect(claimNumbersIn("CI/CD with GitHub Actions")).toEqual([]);
    expect(claimNumbersIn("Văn phòng Hai Phong")).toEqual([]);
  });

  it("still reads a capitalised Vietnamese number word as a duration when a unit follows", () => {
    expect(durationsIn("Ba năm Redux")).toEqual(["3y"]);
    expect(durationsIn("Hai năm với React")).toEqual(["2y"]);
  });
});

describe("durations", () => {
  it.each([
    ["3 years of Redux", ["3y"]],
    ["three years of Redux", ["3y"]],
    ["3+ years", ["3y"]],
    ["3yrs", ["3y"]],
    ["18 months", ["18m"]],
    ["a decade of Redux", ["10y"]],
    ["half a year", ["6m"]],
    ["a year and a half", ["1.5y"]],
    ["since 2021", ["since:2021"]],
    ["since June 2023", ["since:2023-06"]],
    ["several years", ["several-y"]],
    ["3 năm kinh nghiệm", ["3y"]],
    ["ba năm Redux", ["3y"]],
    ["nửa năm", ["6m"]],
    ["từ năm 2021", ["since:2021"]],
    ["Redux", []],
    ["năm 2021", []],
  ])("%j → %j", (text, durations) => {
    expect(durationsIn(text)).toEqual(durations);
  });
});

describe("months and years", () => {
  it("reads Jun 2023, 06/2023, 2023-06 and tháng 6/2023 as the same month", () => {
    for (const t of ["Jun 2023", "June 2023", "06/2023", "6/2023", "2023-06", "tháng 6/2023", "tháng 6 năm 2023", "T6/2023"]) {
      expect(monthsIn(t), t).toEqual(["2023-06"]);
    }
  });

  it("reads Ba's real date forms and bare month names", () => {
    expect(monthsIn("Feb 2024 – Sep 2025")).toEqual(["2024-02", "2025-09"]);
    expect(monthsIn("in June")).toEqual(["*-06"]);
    // "may" is a verb far more often than a month.
    expect(monthsIn("may help")).toEqual([]);
  });

  it("expands year ranges like 2021-25 and keeps the year of a month", () => {
    expect(claimsIn("2021-25").numbers).toEqual(["2021", "2025"]);
    expect(claimsIn("2021 – 2025").numbers).toEqual(["2021", "2025"]);
    expect(claimsIn("Jun 2023").numbers).toEqual(["2023"]);
    expect(claimsIn("2023 – Present").present).toBe(true);
    expect(claimsIn("2023 – hiện tại").present).toBe(true);
  });
});

describe("titles", () => {
  it.each([
    ["Tech Lead", ["lead"]],
    ["Senior Frontend Engineer", ["senior", "engineer"]],
    ["Head of Platform", ["head"]],
    ["CTO", ["cto"]],
    ["Trưởng nhóm kỹ sư", ["lead", "engineer"]],
    ["Lập trình viên cao cấp", ["developer", "senior"]],
    ["DevOps engineering with Redux", []],
  ])("%j → %j", (text, titles) => {
    expect(titlesIn(text)).toEqual(titles);
  });
});

describe("unsupportedClaims: a claim must be in the cited facts", () => {
  const f12 = src(["Built CI pipelines in GitHub Actions for 6 services"], ["2023-2025"]);
  const f3 = src(["Built the customer portal in React and Next.js", "Frontend Engineer"], ["2023-2025"]);

  it("REQ-27.AC-1 / AC-4, SEC-15.AC-2: the same number passes in any form, another number fails", () => {
    expect(unsupportedClaims("CI/CD with GitHub Actions for 6 services", f12)).toEqual([]);
    expect(unsupportedClaims("CI/CD with GitHub Actions for six services", f12)).toEqual([]);
    expect(unsupportedClaims("CI/CD for 10 services", f12)).toEqual([{ kind: "number", value: "10" }]);
    expect(unsupportedClaims("CI/CD for ten services", f12)).toEqual([{ kind: "number", value: "10" }]);
  });

  it("REQ-27.AC-2, SEC-15.AC-1: no duration a cited fact's text does not state, in any wording", () => {
    for (const t of ["3 years of Redux", "three years of Redux", "a decade of Redux", "3+ yrs of Redux", "Redux since 2023", "ba năm Redux"]) {
      expect(unsupportedClaims(t, f3), t).not.toEqual([]);
    }
    expect(unsupportedClaims("Redux", f3)).toEqual([]);
    // The years in a cited fact's dates are not a duration in its text.
    expect(unsupportedClaims("2 years of Redux", f3)).toEqual([{ kind: "duration", value: "2y" }]);
    expect(unsupportedClaims("Ran CI for 3 years", src(["Ran CI on GitHub Actions for three years"]))).toEqual([]);
  });

  it("REQ-27.AC-3: dates outside the cited facts fail", () => {
    expect(unsupportedClaims("CI/CD, 2021-2025", f12)).toEqual([{ kind: "number", value: "2021" }]);
    expect(unsupportedClaims("CI/CD, 2023-2025", f12)).toEqual([]);
    expect(unsupportedClaims("CI/CD, 2023-25", f12)).toEqual([]);
  });

  it("months: Jun 2023 equals 06/2023; a month the facts lack fails; Present needs Present", () => {
    const dated = src(["Built the portal"], ["06/2023 – Present"]);
    expect(unsupportedClaims("Since Jun 2023", src(["Since June 2023 I ran CI"], []))).toEqual([]);
    expect(unsupportedClaims("Portal, Jun 2023 – hiện tại", dated)).toEqual([]);
    expect(unsupportedClaims("Portal, Jul 2023", dated)).toEqual([{ kind: "month", value: "2023-07" }]);
    expect(unsupportedClaims("Portal, 2023 – Present", src(["Built the portal"], ["2023 – 2025"]))).toEqual([{ kind: "present", value: "present" }]);
    expect(unsupportedClaims("Portal, Feb 2024", src(["x"], ["Feb 2024 – Sep 2025"]))).toEqual([]);
  });

  it("REQ-28.AC-1: a title the cited facts do not contain fails, in English or Vietnamese", () => {
    expect(unsupportedClaims("Tech Lead for the portal", f3)).toEqual([{ kind: "title", value: "lead" }]);
    expect(unsupportedClaims("Trưởng nhóm frontend", f3)).toEqual([{ kind: "title", value: "lead" }]);
    expect(unsupportedClaims("Frontend Engineer on the portal", f3)).toEqual([]);
    expect(unsupportedClaims("Kỹ sư frontend", f3)).toEqual([]);
  });

  it("SEC-15.AC-3: a text with nothing beyond its facts passes", () => {
    expect(unsupportedClaims("Redux", f3)).toEqual([]);
    expect(unsupportedClaims("Kubernetes", src(["Deployed services on EKS with Docker"]))).toEqual([]);
  });
});
