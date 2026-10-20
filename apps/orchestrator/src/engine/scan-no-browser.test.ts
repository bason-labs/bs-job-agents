// Live 2026-10-20: a browser scan that never reached Chrome (no page opened, or the bot says the
// extension was not connected) is a source that was not scanned, never "0 results". Decided in
// code from the output, not left to the model.
import { researchScanFixture } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import { fake } from "./testing/fake-runner.js";
import { createTestEngine, type TestEngine } from "./testing/harness.js";
import type { JoinStepOutput } from "./state.js";

const START = { workflow: "job-scan", params: { searchProfileId: null, overrides: null } } as const;
const NOTICE = "LinkedIn was not scanned: Chrome isn't connected. Open Chrome with the Claude extension and scan again.";
const empty = (over: Record<string, unknown> = {}) => ({ ...researchScanFixture, jobs: [], pageViews: 0, blocked: null, ...over });
const scanOf = (t: TestEngine) => t.tasks("research.scan").find((x) => (x.input as { source: string }).source === "linkedin")!;
const leadTexts = (t: TestEngine) => t.events("message.created").map((e) => e.message).filter((m) => m.author.type === "bot" && m.author.bot === "lead").map((m) => m.text);

async function scan(output: Record<string, unknown>) {
  const t = await createTestEngine({ sources: ["linkedin"] });
  t.runner.script({ bot: "research", kind: "scan", result: fake.ok(output) });
  const run = t.engine.startWorkflow(START, { trigger: "chat" });
  await t.idle();
  return { t, run };
}

describe("a browser scan that could not reach Chrome", () => {
  it("no job and no page viewed: the source failed with the Chrome notice, not 0 results; no retry", async () => {
    const { t, run } = await scan(empty());
    expect(scanOf(t)).toMatchObject({ status: "failed", attempt: 1 });
    expect(scanOf(t).error).toMatch(/^chrome not connected/);
    expect(leadTexts(t)).toContain(NOTICE);
    const join = t.step(run.id, "scan-join")!.output as JoinStepOutput;
    expect(join.failures).toHaveLength(1);
    expect(join.failures[0]!.error).toMatch(/^chrome not connected/);
    expect(t.runner.callsFor("research.scan")).toHaveLength(1);
  });

  it("the bot says the extension was not connected (tabs_context_mcp failed), even with a page count", async () => {
    const selfCheck = [{ item: "Every job has a reachable URL", passed: true, note: "No jobs: the Chrome extension was not connected (tabs_context_mcp failed twice)." }];
    const { t } = await scan(empty({ pageViews: 1, selfCheck }));
    expect(scanOf(t)).toMatchObject({ status: "failed" });
    expect(leadTexts(t)).toContain(NOTICE);
  });

  it("a scan that opened pages and found nothing is still 0 results (done)", async () => {
    const { t } = await scan(empty({ pageViews: 2 }));
    expect(scanOf(t)).toMatchObject({ status: "done" });
    expect(leadTexts(t)).not.toContain(NOTICE);
  });
});
