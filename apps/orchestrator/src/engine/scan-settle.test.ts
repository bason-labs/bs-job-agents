// AD-6 (REQ-3): output from every non-browser path settles through one pipeline: each posting is
// validated alone (invalid ones dropped, the rest kept), the research bot's self-check items are
// computed, then the scan checker; the scan's dedupe step follows as for any source.
import { researchScanFixture } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import type { ScanCheckInput, ScanOutputChecker } from "./scan-check.js";
import { SCAN_SELF_CHECK_ITEMS, settleScanOutput } from "./scan-settle.js";

const JOB = { ...researchScanFixture.jobs[0]!, source: "itviec" as const, url: "https://itviec.com/it-jobs/frontend-engineer-novapay-1234" };
const meta = { taskId: 7, runId: 3, attempt: 1, engine: "claude" as const };
const settle = (jobs: unknown[], checker?: ScanOutputChecker) =>
  settleScanOutput({ source: "itviec", taskInput: { source: "itviec" }, jobs, selfCheck: [{ item: "Read ITviec through its account API (no bot, no LLM)", passed: true, note: null }], ...meta, ...(checker ? { checker } : {}) });

describe("settleScanOutput", () => {
  it("a posting without a job URL is dropped and the others are kept (REQ-3.AC-1)", async () => {
    const second = { ...JOB, url: "https://itviec.com/it-jobs/backend-engineer-novapay-5678", title: "Backend Engineer" };
    const r = await settle([JOB, { ...JOB, url: null }, { ...JOB, title: "" }, second]);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.output.jobs.map((j) => j.title)).toEqual([JOB.title, "Backend Engineer"]);
    expect(r.dropped).toEqual([expect.stringMatching(/^posting 2: no job URL/), expect.stringMatching(/^posting 3: title/)]);
    expect(r.output).toMatchObject({ pageViews: 0, blocked: null, injectionSuspected: false, injectionNote: null, memoryNotes: [] });
    expect(r.output.selfCheck.map((s) => s.item)).toEqual(["Read ITviec through its account API (no bot, no LLM)", ...SCAN_SELF_CHECK_ITEMS]);
  });

  it("a snippet fails the self-check 'Every job has full JD text (not a snippet)' like a browser item (REQ-3.AC-3)", async () => {
    const r = await settle([{ ...JOB, jdText: "React, TypeScript. Apply now!" }]);
    expect(r).toMatchObject({ kind: "failed", retryable: true, error: "self-check failed: Every job has full JD text (not a snippet)" });
  });

  it("two postings with one URL fail 'No job is a duplicate of another in this output'", async () => {
    const r = await settle([JOB, { ...JOB }]);
    expect(r).toMatchObject({ kind: "failed", error: "self-check failed: No job is a duplicate of another in this output" });
  });

  it("then the scan checker: told the output came from an API; a broken verdict fails for good, an implausible one is retried", async () => {
    const seen: ScanCheckInput[] = [];
    const ok = await settle([JOB], { check: (i) => (seen.push(i), { ok: true }) });
    expect(ok.kind).toBe("ok");
    expect(seen[0]).toMatchObject({ source: "itviec", via: "api", screenshots: [], taskId: 7, attempt: 1 });
    expect(await settle([JOB], { check: () => ({ ok: false, adapterBroken: true, reason: "layout" }) })).toMatchObject({ kind: "failed", retryable: false, error: "adapter broken: layout (screenshot: not captured)" });
    expect(await settle([JOB], { check: () => ({ ok: false, adapterBroken: false, reason: "odd" }) })).toMatchObject({ kind: "failed", retryable: true, error: "scan output rejected: odd" });
    expect((await settle([JOB], { check: () => { throw new Error("bug"); } })).kind).toBe("ok");
  });

  it("zero postings is a valid empty result (REQ-1.AC-3)", async () => {
    const r = await settle([]);
    expect(r).toMatchObject({ kind: "ok", output: { jobs: [] } });
  });
});
