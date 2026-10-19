import { describe, expect, it } from "vitest";
import type { TailoredCv } from "../bots/cv.js";
import { checkCvClaims, cvClaimsError } from "./cv-claims.js";

const fact = (id: string, text: string, dates: string | null = null) => ({ id, text, textVi: null, tags: [], org: "Gradion", dates });

function cv(subheading: string | null, bullet: string, factIds = ["f-12"]): TailoredCv {
  return {
    headline: "Engineer",
    contactLine: "Ba Huynh · +84 37 247 4489",
    summary: null,
    sections: [{ kind: "experience", title: "Experience", items: [{ heading: "Engineer, Gradion", subheading, bullets: [{ text: bullet, factIds }] }] }],
    layout: { template: "t", font: "Inter", accentColor: "#123456", columns: 1, sectionOrder: ["experience"] },
  };
}

describe("checkCvClaims (SEC-25)", () => {
  it("SEC-25.AC-1: f-12 dates '2023-2025' and a revision showing '06/2023 – 08/2025' is rejected", () => {
    const problems = checkCvClaims(cv("06/2023 – 08/2025", "Built REST APIs"), [fact("f-12", "Built REST APIs", "2023-2025")]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ where: "Experience › Engineer, Gradion, dates" });
    expect(problems[0]!.problems.map((p) => p.kind)).toEqual(["month", "month"]);
    expect(cvClaimsError(problems)).toMatch(/^the truth check failed before QA \(SEC-25\): Experience › Engineer, Gradion, dates says 06\/2023/);
  });

  it("SEC-25.AC-2: f-5 with no result figure and a revision adding 'cut latency by 30%' is rejected", () => {
    const problems = checkCvClaims(cv("2023 – 2025", "Optimised the order service and cut latency by 30%", ["f-5"]), [fact("f-5", "Optimised the order service", "2023 – 2025")]);
    expect(problems.map((p) => p.problems)).toEqual([[{ kind: "number", value: "30" }]]);
  });

  it("SEC-25.AC-3: f-12 '06/2023-08/2025' and a revision showing '06/2023 – 08/2025' passes", () => {
    expect(checkCvClaims(cv("06/2023 – 08/2025", "Built REST APIs"), [fact("f-12", "Built REST APIs", "06/2023-08/2025")])).toEqual([]);
  });

  it("numbers the cited fact gives pass, in another form; a summary is checked against its own facts", () => {
    const c = cv("Sep 2025 – Present", "Owned an app used by ~300 employees", ["g-1"]);
    c.summary = { text: "4+ years of web development", factIds: ["m-1"] };
    const facts = [fact("g-1", "Owned an app used by about 300 employees", "Sep 2025 – Present"), fact("m-1", "4+ years of web development experience.")];
    expect(checkCvClaims(c, facts)).toEqual([]);
    c.summary = { text: "6 years of web development", factIds: ["m-1"] };
    expect(checkCvClaims(c, facts).map((p) => p.where)).toEqual(["summary"]);
  });

  it("job titles are left to QA (SEC-25 checks numbers, months, years and durations)", () => {
    expect(checkCvClaims(cv(null, "Led the frontend team"), [fact("f-12", "Built the frontend")])).toEqual([]);
  });
});
