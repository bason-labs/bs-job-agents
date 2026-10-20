// Live 2026-10-20: fit reasons called Ba "he". Ba's pronouns are not recorded, so text written about
// Ba uses the name or they/them; a narrow code check catches the slip and the attempt is retried.
import { researchFitFixture, researchScanFixture } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import { pronounsAboutBa } from "./fit-pronouns.js";
import { fake } from "./testing/fake-runner.js";
import { createTestEngine } from "./testing/harness.js";

describe("pronounsAboutBa", () => {
  it("finds he/him/his/she/her/hers in sentences about the master CV or Ba, and at the start of a sentence", () => {
    expect(pronounsAboutBa(["The master CV says he mostly uses ReactJs."])).toEqual(["The master CV says he mostly uses ReactJs."]);
    expect(pronounsAboutBa(["React matches. He owned React/Node.js apps used by 300 employees."])).toEqual(["He owned React/Node.js apps used by 300 employees."]);
    expect(pronounsAboutBa(["Ba led her team's migration."])).toEqual(["Ba led her team's migration."]);
  });

  it("leaves everything else alone: the name, they/them, and pronouns in sentences about the JD or the company", () => {
    expect(
      pronounsAboutBa([
        "Ba owned React/Node.js apps; they also wrote the tests.",
        "The master CV lists Next.js and TypeScript.",
        "The JD says the hiring manager wants someone who shares her love of testing.",
        "The other candidates' theme: hero, these, shell, heresy.",
      ]),
    ).toEqual([]);
  });
});

describe("a research.fit that calls Ba he or she", () => {
  it("fails the attempt as invalid output and is retried; the clean retry is kept", async () => {
    const t = await createTestEngine();
    t.runner.script({ bot: "research", kind: "scan", result: fake.ok({ ...researchScanFixture, jobs: [researchScanFixture.jobs[0]!] }) });
    const he = { ...researchFitFixture, fit: { ...researchFitFixture.fit, reasons: ["He owned React/Node.js apps used by about 300 employees."] } };
    t.runner.script({ bot: "research", kind: "fit", times: 1, result: fake.ok(he) });
    t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    const fits = t.tasks("research.fit");
    expect(fits).toHaveLength(1);
    expect(fits[0]).toMatchObject({ status: "done", attempt: 2 });
    expect(t.runner.callsFor("research.fit")).toHaveLength(2);
    expect(JSON.stringify(fits[0]!.output)).not.toMatch(/\bHe owned\b/);
  });
});
