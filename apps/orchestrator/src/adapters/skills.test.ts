// W4a (PM2 S26): the adapter runs as a skill Research reads plus this code. Keep the two in step:
// the skills state the selectors the parsers use, the URLs sources.ts builds, LinkedIn's limits and
// the exact self-check notes the checker reacts to.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SourceScanChecker } from "./checker.js";
import { PARSERS } from "./pages.js";
import { SOURCE_ADAPTERS } from "./sources.js";

const skill = (name: string) => readFileSync(new URL(`../../../../bots/research/skills/source-${name}/SKILL.md`, import.meta.url), "utf8");

const SKILLS = { topcv: "topcv", itviec: "itviec", linkedin: "linkedin", career_site: "career-site" } as const;

describe("bots/research/skills/source-*", () => {
  it.each(Object.entries(SKILLS))("%s: has a front matter name and description, and is read-only", (_source, dir) => {
    const md = skill(dir);
    expect(md).toMatch(new RegExp(`^---\\nname: source-${dir}\\ndescription: .+\\n---\\n`));
    expect(md).toMatch(/Read-only/);
    expect(md).toMatch(/observed 2026-10/);
  });

  it.each(Object.entries(SKILLS))("%s: names the card and JD selectors the parser uses", (source, dir) => {
    const md = skill(dir);
    const parser = PARSERS[source as keyof typeof PARSERS];
    const card = parser.cardSelector.split(",")[0]!.trim().replace(/\[.*$/, "");
    expect(md).toContain(card);
    expect(md).toContain(parser.jdSelector.split(",")[0]!.trim());
  });

  it("the TopCV and ITviec city codes match the search URLs the code builds", () => {
    for (const code of ["ho-chi-minh-kl2", "ha-noi-kl1", "da-nang-kl8"]) expect(skill("topcv")).toContain(code);
    for (const code of ["ho-chi-minh-hcm", "ha-noi", "da-nang"]) expect(skill("itviec")).toContain(code);
    expect(skill("linkedin")).toContain("f_TPR=r604800");
  });

  it("LinkedIn's limits are the ones the checker enforces (UC-03 c)", () => {
    const md = skill("linkedin");
    const li = SOURCE_ADAPTERS.linkedin;
    expect(md).toContain(`At most ${li.maxPageViews} page views per scan`);
    expect(md).toContain(`${li.minDelayMs / 1000}–${li.maxDelayMs / 1000} s`);
  });

  it.each(Object.entries(SKILLS))("%s: its 'Layout changed' and 'No results' notes are the ones the checker reads", (source, dir) => {
    const md = skill(dir);
    const layout = /`(Layout changed: [^`]+)`/.exec(md)?.[1];
    const empty = /`(No results: [^`]+)`/.exec(md)?.[1];
    expect(layout).toBeDefined();
    expect(empty).toBeDefined();
    const base = { taskId: 1, runId: 1, attempt: 1, engine: "claude" as const, source, input: null, screenshots: [] };
    const out = (note: string) => ({ jobs: [], pageViews: 1, blocked: null, injectionSuspected: false, injectionNote: null, selfCheck: [{ item: "x", passed: true, note }], memoryNotes: [] });
    const c = new SourceScanChecker();
    expect(c.check({ ...base, output: out(layout!) })).toMatchObject({ ok: false, adapterBroken: true });
    // A confirmed empty search never counts towards "adapter broken".
    expect(c.check({ ...base, output: out(empty!) })).toEqual({ ok: true });
    expect(c.check({ ...base, output: out(empty!) })).toEqual({ ok: true });
  });
});
