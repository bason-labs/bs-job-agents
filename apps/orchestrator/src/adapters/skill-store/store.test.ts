// Skill self-repair §5.5 (SEC-10): the skill store writes exactly one file per source, atomically,
// and refuses links, unknown keys and anything that resolves outside bots/research/skills/.
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultBotsDir } from "../../runner/config.js";
import { SkillStore, SkillStoreRefused } from "./store.js";

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A copy of the repository's bots/ folder in a temp repo root. */
function repo(): { root: string; bots: string; store: SkillStore } {
  const root = mkdtempSync(join(tmpdir(), "bsja-skills-"));
  temps.push(root);
  const bots = join(root, "bots");
  cpSync(defaultBotsDir(), bots, { recursive: true });
  return { root, bots, store: new SkillStore({ botsDir: bots, repoRoot: root }) };
}

/** Every file under `dir` with its content, for a before/after diff. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(p, readFileSync(p, "utf8"));
    }
  };
  walk(dir);
  return out;
}

const changed = (a: Map<string, string>, b: Map<string, string>) => [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k));

describe("SkillStore (SEC-10)", () => {
  it("reads and replaces bots/research/skills/source-<dir>/SKILL.md, and only that file (SEC-10.AC-3)", () => {
    const { bots, store } = repo();
    const before = snapshot(bots);
    expect(store.pathOf("topcv")).toBe("bots/research/skills/source-topcv/SKILL.md");
    expect(store.read("topcv")).toBe(readFileSync(join(bots, "research/skills/source-topcv/SKILL.md"), "utf8"));
    store.write("topcv", "# new skill\n");
    expect(store.read("topcv")).toBe("# new skill\n");
    expect(changed(before, snapshot(bots))).toEqual([join(bots, "research/skills/source-topcv/SKILL.md")]);
  });

  it("career_site lives in source-career-site", () => {
    const { store } = repo();
    expect(store.pathOf("career_site")).toBe("bots/research/skills/source-career-site/SKILL.md");
    store.write("career_site", "x");
    expect(store.read("career_site")).toBe("x");
  });

  it.each(["../../bots/research/bot", "topcv/../../research", "TopCV", "", "a/b", "nope"])("SEC-10.AC-1: refuses the source key %j and writes nothing", (key) => {
    const { bots, store } = repo();
    const before = snapshot(bots);
    expect(() => store.write(key, "x")).toThrow(SkillStoreRefused);
    expect(changed(before, snapshot(bots))).toEqual([]);
  });

  it("SEC-10.AC-2: refuses a skill folder that holds a symbolic link, and a SKILL.md that is one", () => {
    const { root, bots, store } = repo();
    const outside = join(root, "outside.md");
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, join(bots, "research/skills/source-topcv/extra.md"));
    expect(() => store.write("topcv", "x")).toThrow(/symbolic link/);
    expect(readFileSync(outside, "utf8")).toBe("outside\n");

    const skill = join(bots, "research/skills/source-itviec/SKILL.md");
    rmSync(skill);
    symlinkSync(outside, skill);
    expect(() => store.write("itviec", "x")).toThrow(SkillStoreRefused);
    expect(readFileSync(outside, "utf8")).toBe("outside\n");
  });

  it("SEC-10.AC-2: refuses a skill folder that is a link elsewhere", () => {
    const { root, bots, store } = repo();
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "SKILL.md"), "elsewhere\n");
    rmSync(join(bots, "research/skills/source-linkedin"), { recursive: true });
    symlinkSync(elsewhere, join(bots, "research/skills/source-linkedin"));
    expect(() => store.write("linkedin", "x")).toThrow(SkillStoreRefused);
    expect(readFileSync(join(elsewhere, "SKILL.md"), "utf8")).toBe("elsewhere\n");
  });

  it("refuses a source with no skill folder (it never creates one)", () => {
    const { bots, store } = repo();
    expect(() => store.write("remoteok", "x")).toThrow(/no skill folder/);
    expect(readdirSync(join(bots, "research/skills")).includes("source-remoteok")).toBe(false);
  });

  it("a SKILL.md that is not a regular file is refused; nothing is left behind", () => {
    const { bots, store } = repo();
    const dir = join(bots, "research/skills/source-topcv");
    const before = readFileSync(join(dir, "SKILL.md"), "utf8");
    // A folder in the way of the rename target makes renameSync fail after the temp file was written.
    rmSync(join(dir, "SKILL.md"));
    mkdirSync(join(dir, "SKILL.md"));
    expect(() => store.write("topcv", "new")).toThrow();
    expect(readdirSync(dir)).toEqual(["SKILL.md"]);
    rmSync(join(dir, "SKILL.md"), { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), before);
    expect(store.read("topcv")).toBe(before);
  });
});
