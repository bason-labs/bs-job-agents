// AD-7's checks (spine.md), run as tests: only the skill-repair flow and the wiring import the skill
// store, and neither names bot config, roles, the prompt lock, workflows or allowed sites (NG5).
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("..", import.meta.url).pathname;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
}

const rel = (p: string) => relative(SRC, p).split(sep).join("/");
const isTest = (p: string) => p.endsWith(".test.ts");

describe("AD-7: skill repair boundaries", () => {
  it("only engine/skill-repair.ts, engine/wiring.ts and the store itself import adapters/skill-store", () => {
    const allowed = (p: string) => p === "engine/skill-repair.ts" || p === "engine/wiring.ts" || p.startsWith("adapters/skill-store/");
    const offenders = files(SRC)
      .filter((p) => !isTest(p) && !allowed(rel(p)))
      .filter((p) => /from\s+["'][^"']*skill-store[^"']*["']/.test(readFileSync(p, "utf8")))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("the repair flow and the store never name bot config, roles, the prompt lock, workflows or allowed sites", () => {
    const paths = [join(SRC, "engine/skill-repair.ts"), ...files(join(SRC, "adapters/skill-store")).filter((p) => !isTest(p))];
    const forbidden = /bot\.json|ROLE\.md|prompt-v[e]rsions\.json|workflows\/|allowedSites/;
    expect(paths.filter((p) => forbidden.test(readFileSync(p, "utf8"))).map(rel)).toEqual([]);
  });
});
