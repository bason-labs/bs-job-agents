// PM3 S8: the ScanOutputChecker port. Where a research.scan output settles, the engine asks the
// checker (W4a implements the real one in src/adapters/**). Default: accept. A broken adapter fails
// the branch for good with UC-03 b's "<source> adapter broken" (plus the screenshot or "not
// captured"); an implausible output fails the attempt so it is retried.
import { researchScanFixture } from "@bs-job-agents/shared/fixtures";
import type { ResearchScanOutput } from "@bs-job-agents/shared";
import { describe, expect, it } from "vitest";
import { acceptAllScanOutputChecker, basicScanOutputChecker, type ScanCheckInput, type ScanOutputChecker } from "./scan-check.js";
import { createTestEngine, fake, type TestEngine } from "./testing/index.js";

const scanParams = { workflow: "job-scan" as const, params: { searchProfileId: null, overrides: null } };

function texts(t: TestEngine): string[] {
  return t.events("message.created").map((e) => e.message.text);
}

const topcv = (task: { input: unknown }) => (task.input as { source: string }).source === "topcv";

describe("ScanOutputChecker in the engine (PM3 S8)", () => {
  it("by default every scan output is accepted", async () => {
    const t = await createTestEngine({ sources: ["itviec"] });
    t.engine.startWorkflow(scanParams, { trigger: "chat" });
    await t.idle();
    expect(t.tasks("research.scan").map((x) => x.status)).toEqual(["done"]);
  });

  it("asks the checker once per settled scan, with the source, input, output and screenshots", async () => {
    const seen: ScanCheckInput[] = [];
    const checker: ScanOutputChecker = { check: (i) => (seen.push(i), { ok: true }) };
    const t = await createTestEngine({ sources: ["itviec", "topcv"], scanChecker: checker });
    t.engine.startWorkflow(scanParams, { trigger: "chat" });
    await t.idle();
    expect(seen.map((s) => s.source).sort()).toEqual(["itviec", "topcv"]);
    expect(seen[0]).toMatchObject({ attempt: 1, engine: expect.any(String), screenshots: [], output: { jobs: expect.any(Array) } });
    expect(seen[0]!.input).toMatchObject({ source: seen[0]!.source });
    expect(t.runner.callsFor("research.fit").length).toBeGreaterThan(0);
  });

  it("passes the runner's page visits (URL + time of each navigate), so the checker can hold LinkedIn's pauses (W4a handoff)", async () => {
    const seen: ScanCheckInput[] = [];
    const checker: ScanOutputChecker = { check: (i) => (seen.push(i), { ok: true }) };
    const t = await createTestEngine({ sources: ["itviec"], scanChecker: checker });
    const pageVisits = [
      { url: "https://itviec.com/it-jobs?q=react", at: "2026-10-11T02:00:00.000Z" },
      { url: "https://itviec.com/it-jobs/novapay-1", at: "2026-10-11T02:00:05.000Z" },
    ];
    t.runner.script({ bot: "research", kind: "scan", times: 1, result: { ...fake.ok({ ...researchScanFixture, jobs: researchScanFixture.jobs.filter((j) => j.source === "itviec") }), pageVisits } });
    t.engine.startWorkflow(scanParams, { trigger: "chat" });
    await t.idle();
    expect(seen[0]!.pageVisits).toEqual(pageVisits);
  });

  it("a broken adapter fails that branch for good (no retry) with UC-03 b's note; the other sources go on", async () => {
    const checker: ScanOutputChecker = {
      check: (i) => (i.source === "topcv" ? { ok: false, adapterBroken: true, reason: "no job cards on the results page (layout changed?)", screenshot: null } : { ok: true }),
    };
    const t = await createTestEngine({ sources: ["itviec", "topcv"], scanChecker: checker });
    t.engine.startWorkflow(scanParams, { trigger: "chat" });
    await t.idle();
    expect(t.runner.calls.filter((c) => c.kind === "scan" && topcv(c))).toHaveLength(1);
    const failed = t.tasks("research.scan").find(topcv)!;
    expect(failed).toMatchObject({ status: "failed", error: "adapter broken: no job cards on the results page (layout changed?) (screenshot: not captured)" });
    expect(texts(t).filter((x) => /TopCV/.test(x))).toEqual([
      "TopCV adapter broken: no job cards on the results page (layout changed?) (screenshot: not captured). The other sources go on.",
    ]);
    expect(t.tasks("research.scan").find((x) => !topcv(x))!.status).toBe("done");
  });

  it("names the screenshot the checker picked", async () => {
    const checker: ScanOutputChecker = { check: () => ({ ok: false, adapterBroken: true, reason: "missing salary block", screenshot: "screenshots/1-1/2.png" }) };
    const t = await createTestEngine({ sources: ["topcv"], scanChecker: checker });
    t.engine.startWorkflow(scanParams, { trigger: "chat" });
    await t.idle();
    expect(t.tasks("research.scan")[0]!.error).toBe("adapter broken: missing salary block (screenshot: screenshots/1-1/2.png)");
  });

  it("an implausible output (not a broken adapter) fails the attempt, and the retry can pass", async () => {
    let calls = 0;
    const checker: ScanOutputChecker = { check: () => (++calls === 1 ? { ok: false, adapterBroken: false, reason: "job 1 has no company" } : { ok: true }) };
    const t = await createTestEngine({ sources: ["itviec"], scanChecker: checker });
    t.engine.startWorkflow(scanParams, { trigger: "chat" });
    await t.idle();
    expect(t.runner.callsFor("research.scan")).toHaveLength(2);
    expect(t.tasks("research.scan")[0]!.status).toBe("done");
  });

  it("a checker that throws never fails a scan (logged, accepted)", async () => {
    const t = await createTestEngine({ sources: ["itviec"], scanChecker: { check: () => { throw new Error("bug in adapter"); } } });
    t.engine.startWorkflow(scanParams, { trigger: "chat" });
    await t.idle();
    expect(t.tasks("research.scan")[0]!.status).toBe("done");
  });

  it("only research.scan outputs are checked (not single, file, fit or company)", async () => {
    const kinds: string[] = [];
    const t = await createTestEngine({ sources: ["itviec"], scanChecker: { check: (i) => (kinds.push(i.source), { ok: true }) } });
    t.runner.script({ bot: "research", kind: "scan", result: fake.ok(researchScanFixture) });
    t.engine.startWorkflow(scanParams, { trigger: "chat" });
    await t.idle();
    expect(kinds).toEqual(["itviec"]);
  });
});

describe("the default checkers", () => {
  const input = (source: string, output: ResearchScanOutput): ScanCheckInput => ({
    taskId: 1,
    runId: 1,
    attempt: 1,
    engine: "claude",
    source,
    input: { source },
    output,
    screenshots: [],
  });

  it("acceptAll accepts anything", async () => {
    expect(await acceptAllScanOutputChecker.check(input("topcv", { ...researchScanFixture, jobs: [] }))).toEqual({ ok: true });
  });

  it("basic: a job from another source, or a board job without a URL, is rejected (retry); an empty list is fine (UC-03 d)", async () => {
    const job = researchScanFixture.jobs[0]!;
    expect(await basicScanOutputChecker.check(input("itviec", { ...researchScanFixture, jobs: [job] }))).toEqual({ ok: true });
    expect(await basicScanOutputChecker.check(input("topcv", { ...researchScanFixture, jobs: [] }))).toEqual({ ok: true });
    expect(await basicScanOutputChecker.check(input("topcv", { ...researchScanFixture, jobs: [job] }))).toEqual({
      ok: false,
      adapterBroken: false,
      reason: "job 1 (NovaPay) says it comes from itviec, not topcv",
    });
    expect(await basicScanOutputChecker.check(input("itviec", { ...researchScanFixture, jobs: [{ ...job, url: null }] }))).toEqual({
      ok: false,
      adapterBroken: false,
      reason: "job 1 (NovaPay) has no posting URL",
    });
  });
});
