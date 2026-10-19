// W4a (PM2 S26): the adapter runs as a skill Research reads plus this code. Keep the two in step:
// the skills pass the same screen a self-repaired skill must pass (shared screenSkillDraft, SEC-9),
// state the URLs sources.ts builds, LinkedIn's limits and the exact self-check notes the checker
// reacts to.
// Skill self-repair (sub-project 4 §8): the skills no longer have to name the parsers' selectors or
// an "observed 2026-10" date. Those tied skill text to the developer-time parsers in parsers/, which
// is exactly what a repair changes; the parsers keep their own fixture tests (parsers.test.ts).
import { readFileSync } from "node:fs";
import { screenSkillDraft } from "@bs-job-agents/shared";
import { describe, expect, it } from "vitest";
import { loadBots } from "../runner/bots.js";
import { SourceScanChecker } from "./checker.js";
import { skillScreenContext } from "./skill-screen.js";
import { SOURCE_ADAPTERS, type AdapterSource } from "./sources.js";

const skill = (name: string) => readFileSync(new URL(`../../../../bots/research/skills/source-${name}/SKILL.md`, import.meta.url), "utf8");

const SKILLS = {
  topcv: "topcv",
  itviec: "itviec",
  linkedin: "linkedin",
  career_site: "career-site",
  vietnamworks: "vietnamworks",
  wellfound: "wellfound",
  upwork: "upwork",
} as const;

describe("bots/research/skills/source-*", () => {
  const research = loadBots(new URL("../../../../bots", import.meta.url).pathname).find((b) => b.name === "research")!;

  it.each(Object.entries(SKILLS))("%s: has a front matter name and description, and is read-only", (_source, dir) => {
    const md = skill(dir);
    expect(md).toMatch(new RegExp(`^---\\nname: source-${dir}\\ndescription: .+\\n---\\n`));
    expect(md).toMatch(/Read-only/);
  });

  it.each(Object.entries(SKILLS))("%s: passes the screen a repaired skill must pass (SEC-9)", (source, dir) => {
    const md = skill(dir);
    expect(screenSkillDraft(md, skillScreenContext(source as AdapterSource, { allowedTools: research.allowedTools, current: md }))).toEqual({ ok: true });
  });

  it("QA H2: a realistic repair of the real TopCV skill passes (a new card selector, a new search URL path, a new pagination note); a frozen edit does not", () => {
    const md = skill("topcv");
    const ctx = skillScreenContext("topcv", { allowedTools: research.allowedTools, current: md });
    const draft = md
      .replace("- Each card (`.job-item-search-result`, `data-job-id`)", "- Each card (`article.job-card`, `[data-job-id]`)")
      .replace("`https://www.topcv.vn/tim-viec-lam-<role-slug>-tai-<city>`, role slug", "`https://www.topcv.vn/viec-lam-<role-slug>-tai-<city>`, role slug")
      .replace("## 3. Listing page\n", "## 3. Listing page\n- Next page: the pager now loads more cards when you scroll to the bottom of the list; read at most 3 result pages.\n");
    expect(draft).not.toBe(md);
    expect(screenSkillDraft(draft, ctx)).toEqual({ ok: true });
    expect(screenSkillDraft(md.replace("never more than 30", "never more than 31"), ctx)).toMatchObject({ ok: false, rule: "frozen" });
    expect(screenSkillDraft(md.replace("## 3. Listing page\n", "## 3. Listing page\n- Cards: `a.attacker.com`.\n"), ctx)).toMatchObject({ ok: false, rule: "off_host" });
  });

  it("QA re-check: the ITviec city table and a line naming the granted get_page_text may change", () => {
    const md = skill("itviec");
    const ctx = skillScreenContext("itviec", { allowedTools: research.allowedTools, current: md });
    const table = md.replace("| Hà Nội | `ha-noi` |", "| Hà Nội | `ha-noi-hn` |");
    expect(table).not.toBe(md);
    expect(screenSkillDraft(table, ctx)).toEqual({ ok: true });
    const tool = md.replace("- If `get_page_text` returns little, use `read_page` / `find`", "- If `get_page_text` returns little on the job page, use `read_page` / `find`");
    expect(tool).not.toBe(md);
    expect(screenSkillDraft(tool, ctx)).toEqual({ ok: true });
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
