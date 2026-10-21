import { describe, expect, it } from "vitest";
import type { TailoredCv } from "../bots/cv.js";
import type { TaskFact } from "../domain/master-cv.js";
import { datesHaveMonths, listedSkills, mentions, runGuidanceChecks, type GuidanceCheckInput } from "./checks.js";
import { resolveGuidance } from "./resolve.js";
import { GUIDANCE_SEED } from "./seed.js";

const fact = (id: string, over: Partial<TaskFact> = {}): TaskFact => ({ id, type: "experience", text: `Fact ${id}`, textVi: null, tags: [], org: "Gradion", dates: null, ...over });

function cv(over: { subheading?: string | null; skills?: string; bullets?: { text: string; factIds: string[] }[] } = {}): TailoredCv {
  return {
    headline: "Software Engineer",
    contactLine: "Ba Huynh · ba@example.com · +84 37 247 4489",
    summary: null,
    sections: [
      { kind: "experience", title: "Experience", items: [{ heading: "Software Engineer, Gradion", subheading: over.subheading ?? "2023 – 2025", bullets: over.bullets ?? [{ text: "Built REST APIs", factIds: ["f-12"] }] }] },
      { kind: "skills", title: "Skills", items: [{ heading: null, subheading: null, bullets: [{ text: over.skills ?? "Java, Spring Boot", factIds: ["skill-1"] }] }] },
    ],
    layout: { template: "t", font: "Inter", accentColor: "#123456", columns: 1, sectionOrder: ["experience", "skills"] },
  };
}

const contact = { name: "Ba Huynh", email: "ba@example.com", phone: "+84 37 247 4489", links: ["https://www.linkedin.com/in/bahuynh"] };
const resolved = resolveGuidance(GUIDANCE_SEED, { masterContact: contact, jobMarket: "global", turnedOff: [] });

function input(over: Partial<GuidanceCheckInput> = {}): GuidanceCheckInput {
  return {
    cv: cv(),
    pdfText: "Ba Huynh\nba@example.com · +84 37 247 4489 · linkedin.com/in/bahuynh\nExperience\nSoftware Engineer, Gradion 2023 – 2025",
    pageCount: 1,
    facts: [fact("f-12", { text: "Built REST APIs in Java and Spring Boot", dates: "2023-2025" }), fact("skill-1", { type: "skill", text: "Java, Spring Boot", org: null })],
    contact,
    ...over,
  };
}

const itemOf = (items: ReturnType<typeof runGuidanceChecks>, ruleId: string) => items.find((i) => i.ruleId === ruleId)!;

describe("deterministic guidance checkers (§5.6)", () => {
  it("month_year on Ba's real date forms: 'Feb 2024 – Sep 2025' and 'Sep 2025 – Present' have months; '2020 – 2023' does not", () => {
    expect(datesHaveMonths("Feb 2024 – Sep 2025")).toBe(true);
    expect(datesHaveMonths("Sep 2025 – Present")).toBe(true);
    expect(datesHaveMonths("06/2023-08/2025")).toBe(true);
    expect(datesHaveMonths("2020 – 2023")).toBe(false);
    expect(datesHaveMonths("06/2023 – 2025")).toBe(false);
    expect(datesHaveMonths(null)).toBe(false);
  });

  it("REQ-37.AC-2: f-12 '2023-2025' → needs fact, one request for its start and end months; nothing is added", () => {
    const it = itemOf(runGuidanceChecks(resolved, input()), "dates-month-year");
    expect(it.status).toBe("needs_fact");
    expect(it.factRequests).toEqual([{ factId: "f-12", field: "dates", question: expect.stringMatching(/start and end months/) }]);
    expect(it.fix).toBeNull();
  });

  it("REQ-37.AC-3: f-12 '06/2023-08/2025' and the CV shows '06/2023 – 08/2025' → met; years only on the CV → not met, fixable", () => {
    const facts = [fact("f-12", { text: "Built REST APIs in Java and Spring Boot", dates: "06/2023-08/2025" }), fact("skill-1", { type: "skill", text: "Java" })];
    expect(itemOf(runGuidanceChecks(resolved, input({ facts, cv: cv({ subheading: "06/2023 – 08/2025" }) })), "dates-month-year").status).toBe("met");
    const yearsOnly = itemOf(runGuidanceChecks(resolved, input({ facts })), "dates-month-year");
    expect(yearsOnly).toMatchObject({ status: "not_met", fixable: true, fix: { factIds: ["f-12"] } });
  });

  it("REQ-38.AC-2: skill 'Go' with no experience or project fact mentioning it → not met, fix 'remove Go'", () => {
    const it = itemOf(runGuidanceChecks(resolved, input({ cv: cv({ skills: "Java, Spring Boot, Go" }) })), "skills-practical-experience");
    expect(it).toMatchObject({ status: "not_met", fixable: true });
    expect(it.fix!.instruction).toMatch(/^Remove Go\b/);
    expect(it.reason).toMatch(/Go/);
    expect(itemOf(runGuidanceChecks(resolved, input()), "skills-practical-experience").status).toBe("met");
  });

  it("a derived skill resting on an experience fact counts as practice", () => {
    const facts = [...input().facts, { ...fact("d-1", { type: "skill", text: "REST", org: null }), derived: true as const, restsOn: ["f-12"] }];
    expect(itemOf(runGuidanceChecks(resolved, input({ facts, cv: cv({ skills: "Java, REST" }) })), "skills-practical-experience").status).toBe("met");
  });

  it("contact: name, phone and email on the PDF → met; no phone in the master → needs fact (contact.phone); missing on the PDF → fixable", () => {
    expect(itemOf(runGuidanceChecks(resolved, input()), "contact-complete").status).toBe("met");
    const noPhone = itemOf(runGuidanceChecks(resolved, input({ contact: { ...contact, phone: null } })), "contact-complete");
    expect(noPhone).toMatchObject({ status: "needs_fact", factRequests: [{ factId: "contact", field: "contact.phone" }] });
    const missing = itemOf(runGuidanceChecks(resolved, input({ pdfText: "Ba Huynh\nExperience 2023 – 2025" })), "contact-complete");
    expect(missing).toMatchObject({ status: "not_met", fixable: true });
    expect(missing.reason).toMatch(/email, phone/);
  });

  it("links: a link on the PDF → met; not on it → fixable; no link in the master → the rule does not apply (no item)", () => {
    expect(itemOf(runGuidanceChecks(resolved, input()), "links-profile").status).toBe("met");
    expect(itemOf(runGuidanceChecks(resolved, input({ pdfText: "Ba Huynh ba@example.com +84 37 247 4489" })), "links-profile")).toMatchObject({ status: "not_met", fixable: true });
    const noLinks = resolveGuidance(GUIDANCE_SEED, { masterContact: { links: [] }, jobMarket: "global", turnedOff: [] });
    expect(runGuidanceChecks(noLinks, input({ contact: { ...contact, links: [] } })).find((i) => i.ruleId === "links-profile")).toBeUndefined();
  });

  it("page_length records the page count even though the rule is overridden", () => {
    expect(itemOf(runGuidanceChecks(resolved, input({ pageCount: 2 })), "length-pages").reason).toBe("The PDF has 2 pages.");
  });

  it("listedSkills and mentions read labels, separators and dotted names", () => {
    const c = cv({ skills: "Frontend: React, Next.js; TypeScript / Node.js" });
    expect(listedSkills(c)).toEqual(["React", "Next.js", "TypeScript", "Node.js"]);
    expect(mentions("Built apps in NodeJS and React", "Node.js")).toBe(true);
    expect(mentions("Built apps in JavaScript", "Java")).toBe(false);
    expect(mentions("Wrote services in Go and Rust", "Go")).toBe(true);
  });
});
