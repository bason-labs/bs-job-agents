import { describe, expect, it } from "vitest";
import type { TailoredCv } from "../bots/cv.js";
import { checkCvClaims, cvClaimsError } from "./cv-claims.js";

const fact = (id: string, text: string, dates: string | null = null) => ({ id, text, textVi: null, tags: [], org: "Gradion", dates });

function cv(subheading: string | null, bullet: string, factIds = ["f-12"]): TailoredCv {
  return {
    headline: "Engineer",
    contactLine: "Ba Huynh · +84 37 247 4489",
    summary: null,
    sections: [{ kind: "experience", title: "Experience", items: [{ heading: "Gradion", subheading, bullets: [{ text: bullet, factIds }] }] }],
    layout: { template: "t", font: "Inter", accentColor: "#123456", columns: 1, sectionOrder: ["experience"] },
  };
}

describe("checkCvClaims (SEC-25)", () => {
  it("SEC-25.AC-1: f-12 dates '2023-2025' and a revision showing '06/2023 – 08/2025' is rejected", () => {
    const problems = checkCvClaims(cv("06/2023 – 08/2025", "Built REST APIs"), [fact("f-12", "Built REST APIs", "2023-2025")]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ where: "Experience › Gradion, dates" });
    expect(problems[0]!.problems.map((p) => p.kind)).toEqual(["month", "month"]);
    expect(cvClaimsError(problems)).toMatch(/^the truth check failed before QA \(SEC-25\): Experience › Gradion, dates says 06\/2023/);
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

  it("guidance-fix probes: a skill, a title or an employer the facts lack is rejected before QA", () => {
    const facts = [fact("f-12", "Built REST APIs in Java and Spring Boot", "2023-2025"), fact("s-1", "Java, Spring Boot")];
    const probe = (bullet: string, ids = ["f-12"]) => checkCvClaims(cv("2023 – 2025", bullet, ids), facts).flatMap((p) => p.problems);
    expect(probe("Built REST APIs in Java and Spring Boot, deployed on Kubernetes")).toEqual([{ kind: "skill", value: "Kubernetes" }]);
    expect(probe("Senior engineer who built REST APIs in Java")).toEqual(expect.arrayContaining([{ kind: "title", value: "senior" }]));
    expect(probe("Built REST APIs in Java for Google")).toEqual([{ kind: "name", value: "Google" }]);
    expect(cvClaimsError(checkCvClaims(cv(null, "Built REST APIs in Java for Google"), facts))).toMatch(/names Google/);
  });

  it("a term, title or employer the cited facts (or Ba's master CV) give passes", () => {
    const facts = [fact("f-12", "Software Engineer: built REST APIs in Java and Spring Boot at Gradion", "2023-2025"), fact("s-1", "Kubernetes")];
    expect(checkCvClaims(cv(null, "Engineer at Gradion: built REST APIs in Java and Spring Boot"), facts)).toEqual([]);
    // A skill must come from a fact the bullet cites.
    expect(checkCvClaims(cv(null, "Built REST APIs in Java on Kubernetes"), facts).flatMap((p) => p.problems)).toEqual([{ kind: "skill", value: "Kubernetes" }]);
    expect(checkCvClaims(cv(null, "Built REST APIs in Java on Kubernetes", ["f-12", "s-1"]), facts)).toEqual([]);
  });
  it("QA re-check 1: a Vietnamese title from Ba's own headline options passes (Lập trình viên Frontend)", () => {
    const facts = [fact("f-1", "Phát triển giao diện web bằng React và Next.js", "2022 – Present")];
    const c = cv(null, "Phát triển giao diện web bằng React và Next.js", ["f-1"]);
    c.summary = { text: "Lập trình viên Frontend với kinh nghiệm React và Next.js", factIds: ["f-1"] };
    c.sections[0]!.items[0]!.heading = "Frontend Developer · Gradion";
    expect(checkCvClaims(c, facts).flatMap((p) => p.problems)).toEqual(expect.arrayContaining([{ kind: "title", value: "developer" }]));
    const headlines = ["Frontend Developer | React, Next.js & TypeScript", "Lập trình viên Frontend | React, Next.js & TypeScript"];
    expect(checkCvClaims(c, facts, { headlines })).toEqual([]);
  });

  it("QA re-check 2: item headings are checked for titles and names", () => {
    const facts = [fact("f-1", "Software Engineer: built REST APIs in Java", "2022 – Present")];
    const c = cv(null, "Built REST APIs in Java", ["f-1"]);
    c.sections[0]!.items[0]!.heading = "Senior Software Engineer — Google";
    expect(checkCvClaims(c, facts).flatMap((p) => p.problems)).toEqual([
      { kind: "title", value: "senior" },
      { kind: "name", value: "Google" },
    ]);
    c.sections[0]!.items[0]!.heading = "Software Engineer — Gradion";
    expect(checkCvClaims(c, facts)).toEqual([]);
  });
});
