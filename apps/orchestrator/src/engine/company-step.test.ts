// PM2 S16 (UC-05): the company step. A re-run Ba asks for researches the company again (the
// 30-day cache is for new branches only), and a company task that fails for good no longer drops a
// good job: the branch continues with `company: null` and the review card is flagged.
import { describe, expect, it } from "vitest";
import { getCompany, getJob, getRun } from "../db/index.js";
import { fake } from "./testing/fake-runner.js";
import { createTestEngine } from "./testing/harness.js";

const scan = { workflow: "job-scan", params: { searchProfileId: null, overrides: null } } as const;

describe("company step (PM2 S16)", () => {
  it("a company task that fails twice continues the branch with no profile; the card is flagged", async () => {
    const t = await createTestEngine();
    t.runner.script({ bot: "research", kind: "company", result: fake.failed("no public data") });
    const run = t.engine.startWorkflow(scan, { trigger: "chat" });
    await t.idle();
    expect(t.tasks("research.company")).toHaveLength(1);
    expect(t.tasks("research.company")[0]).toMatchObject({ status: "failed", attempt: 2 });
    const company = t.step(run.id, "company", "1")!;
    expect(company.status).toBe("done");
    expect(company.output).toMatchObject({ company: null, failed: true, error: "no public data" });
    expect(t.events("step.finished").filter((e) => e.stepKey === "company").at(-1)).toMatchObject({ status: "done", preview: "company research failed · continuing without it" });
    // CV got no profile, and the card says so.
    expect((t.runner.callsFor("cv.tailor")[0]!.input as { company: unknown }).company).toBeNull();
    expect(t.review(run.id, 1)).toMatchObject({ companyMissing: true });
    expect(t.events("review.ready")[0]).toMatchObject({ jobId: "1", companyMissing: true });
    expect(getRun(t.db, run.id)?.status).toBe("waiting");
  });

  it("a profile that came through leaves the card unflagged", async () => {
    const t = await createTestEngine();
    const run = t.engine.startWorkflow(scan, { trigger: "chat" });
    await t.idle();
    expect(t.review(run.id, 1)).toMatchObject({ companyMissing: false });
    expect(t.events("review.ready")[0]).toMatchObject({ companyMissing: false });
  });

  it("re-running the company step researches the company again, past the 30-day cache", async () => {
    const t = await createTestEngine();
    const run = t.engine.startWorkflow(scan, { trigger: "chat" });
    await t.idle();
    expect(t.tasks("research.company")).toHaveLength(1);
    const company = t.step(run.id, "company", "1")!;
    expect(company.status).toBe("done");
    t.engine.rerunStep(company.id);
    await t.idle();
    expect(t.tasks("research.company")).toHaveLength(2);
    expect(t.step(run.id, "company", "1")?.status).toBe("done");
    expect(t.review(run.id, 1)).toBeDefined();
  });

  it("a re-run of an earlier step still uses the cache for the company", async () => {
    const t = await createTestEngine();
    const run = t.engine.startWorkflow(scan, { trigger: "chat" });
    await t.idle();
    t.engine.rerunStep(t.step(run.id, "fit")!.id);
    await t.idle();
    expect(t.tasks("research.company")).toHaveLength(1);
    expect(t.step(run.id, "company", "1")).toMatchObject({ status: "skipped", output: { cacheHit: true } });
    expect(getCompany(t.db, getJob(t.db, 1)!.companyId)?.profile).not.toBeNull();
    expect(t.review(run.id, 1)).toMatchObject({ companyMissing: false });
  });
});
