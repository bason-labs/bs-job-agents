// Skill self-repair (§5.6, §5.7, §7): the Activity screen's skill entries, "Restore previous skill"
// and "Try repair again" through the API. Both POSTs are state changes under the S18 Origin and
// CSRF checks (SEC-19.AC-1; security-routes.test.ts covers every contract route as well).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ActivityResponseSchema } from "@bs-job-agents/shared";
import { afterEach, describe, expect, it } from "vitest";
import { defaultBotsDir } from "../../runner/config.js";
import { MemorySkillFiles } from "../../engine/testing/index.js";
import type { ScanOutputChecker } from "../../engine/scan-check.js";
import { createApiHarness, type ApiHarness } from "../testing.js";

const TOPCV = readFileSync(join(defaultBotsDir(), "research/skills/source-topcv/SKILL.md"), "utf8");
const broken: ScanOutputChecker = {
  check: (i) => ((i.input as { skillOverride?: unknown }).skillOverride === undefined ? { ok: false, adapterBroken: true, reason: "no job cards", screenshot: null } : { ok: true }),
};

let h: ApiHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function adopted() {
  const skills = new MemorySkillFiles({ topcv: TOPCV });
  h = await createApiHarness({ engine: { sources: ["topcv"], scanChecker: broken, skills } });
  h.t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
  await h.t.idle();
  return { h, skills };
}

describe("skill repairs on the Activity screen (REQ-11)", () => {
  it("GET /activity lists the adopted repair with its diff, newest first with the guidance entries; restore puts the previous skill back", async () => {
    const { h, skills } = await adopted();
    const { entries } = ActivityResponseSchema.parse((await h.get("/activity")).json());
    const entry = entries.find((e) => e.kind === "skill_adopted");
    expect(entry).toMatchObject({ source: "topcv", sourceLabel: "TopCV", canRestore: true, previousText: TOPCV, path: "bots/research/skills/source-topcv/SKILL.md" });
    expect(entries.map((e) => e.at)).toEqual([...entries.map((e) => e.at)].sort().reverse());

    const repairId = entry!.kind === "skill_adopted" ? entry!.repairId : null;
    // SEC-19.AC-1: no CSRF header → 403, nothing restored.
    expect((await h.request("POST", `/skill-repairs/${repairId}/restore`, undefined, { "x-bsja-csrf": "" })).statusCode).toBe(403);
    expect(skills.read("topcv")).not.toBe(TOPCV);
    const res = await h.post(`/skill-repairs/${repairId}/restore`);
    expect(res.statusCode).toBe(200);
    expect(skills.read("topcv")).toBe(TOPCV);
    expect(ActivityResponseSchema.parse(res.json()).entries[0]).toMatchObject({ kind: "skill_restored", source: "topcv" });
    // Only once.
    expect((await h.post(`/skill-repairs/${repairId}/restore`)).statusCode).toBe(409);
    expect((await h.post("/skill-repairs/999/restore")).statusCode).toBe(404);
    expect((await h.post("/skill-repairs/abc/restore")).statusCode).toBe(400);
  });

  it("POST /skill-repairs/sources/:source/retry starts a repair from the last failure; an unknown source is 404, a bad key 400", async () => {
    const { h } = await adopted();
    expect((await h.post("/skill-repairs/sources/itviec/retry")).statusCode).toBe(404);
    expect((await h.post("/skill-repairs/sources/..%2Fbot/retry")).statusCode).toBe(400);
    const res = await h.post("/skill-repairs/sources/topcv/retry");
    expect(res.statusCode).toBe(200);
    expect(ActivityResponseSchema.parse(res.json()).entries.some((e) => e.kind === "skill_repairing" && e.source === "topcv")).toBe(true);
    await h.t.idle();
  });
});
