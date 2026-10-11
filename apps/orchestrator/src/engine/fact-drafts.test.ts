// Owner request 2026-10-11: cv.fact_draft. Ba's own words on the Master CV screen → CV drafts master
// facts on its own engine with no tools (no Figma lock, no Figma calls); the engine validates the
// output, rejects facts with a number or name Ba did not give (the invented-detail guard), and hands
// the rest to the API's FactDraftSink in the settle transaction.
import { FACT_DRAFT_SELF_CHECK, type CvFactDraftInput, type FactDraftOutput } from "@bs-job-agents/shared";
import { cvFactDraftInputFixture, factDraftNoneFixture, factDraftOutputFixture } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import { getTask, listEvents, listMessages, getOrCreateLeadRoom, updateBot } from "../db/index.js";
import { EngineError } from "./errors.js";
import { FACT_DRAFT_REJECTED_EVENT, type FactDraftResult, type FactDraftSink } from "./fact-drafts.js";
import { FakeClock } from "./testing/fake-clock.js";
import type { RunnerTask } from "../runner/types.js";
import { defaultFakeResult, fake, fakeFactDraft } from "./testing/fake-runner.js";
import { createTestEngine } from "./testing/harness.js";

const T0 = new Date("2026-10-10T08:00:00.000Z");
const HOUR = 3600_000;
const INPUT: CvFactDraftInput = cvFactDraftInputFixture;

function code(fn: () => unknown): string | null {
  try {
    fn();
  } catch (err) {
    if (err instanceof EngineError) return err.code;
    throw err;
  }
  return null;
}

function recordingSink(opts: { throwOnDone?: boolean } = {}) {
  const calls: Array<{ kind: "done"; taskId: number; result: FactDraftResult } | { kind: "failed"; taskId: number; error: string }> = [];
  const sink: FactDraftSink = {
    done(ctx, result) {
      calls.push({ kind: "done", taskId: ctx.task.id, result });
      if (opts.throwOnDone) throw new Error("sink bug");
    },
    failed(ctx, error) {
      calls.push({ kind: "failed", taskId: ctx.task.id, error });
    },
  };
  return { sink, calls };
}

const withSelfCheck = (out: Omit<FactDraftOutput, "selfCheck">): FactDraftOutput => ({ ...out, selfCheck: FACT_DRAFT_SELF_CHECK.map((item) => ({ item, passed: true, note: null })) });

describe("enqueueFactDraft (cv.fact_draft)", () => {
  it("validates the strict input before anything is queued", async () => {
    const t = await createTestEngine();
    expect(code(() => t.engine.enqueueFactDraft({ ...INPUT, factRequestId: "x" } as CvFactDraftInput))).toBe("validation_failed");
    expect(code(() => t.engine.enqueueFactDraft({ ...INPUT, text: "  " }))).toBe("validation_failed");
    expect(code(() => t.db.transaction(() => t.engine.enqueueFactDraft(INPUT)))).toBe("conflict");
    expect(t.tasks()).toEqual([]);
  });

  it("refuses when CV is disabled", async () => {
    const t = await createTestEngine();
    updateBot(t.db, "cv", { enabled: false });
    expect(code(() => t.engine.enqueueFactDraft(INPUT))).toBe("conflict");
  });

  it("runs on CV's effective engine without the Figma lock or any Figma call, and hands the facts to the sink", async () => {
    const { sink, calls } = recordingSink();
    const t = await createTestEngine({ factDrafts: sink });
    updateBot(t.db, "cv", { engine: "codex", engineRiskAckAt: T0.toISOString() });
    t.runner.script({ bot: "cv", kind: "fact_draft", result: fake.ok(factDraftOutputFixture) });
    const { taskId } = t.engine.enqueueFactDraft(INPUT);
    await t.idle();
    expect(getTask(t.db, taskId)).toMatchObject({ status: "done", engine: "codex", runId: null, stepId: null, usesFigma: false, usesBrowser: false });
    expect(t.figma.calls).toEqual([]);
    const call = t.runner.callsFor("cv.fact_draft")[0]!;
    expect(call.input).toEqual(INPUT);
    // No read folder (no master-cv.yaml copy), no hooks: the task has no tools.
    expect(call.readDirs).toBeUndefined();
    expect(call.hookSettings).toBeUndefined();
    expect(calls).toEqual([{ kind: "done", taskId, result: { output: factDraftOutputFixture, accepted: factDraftOutputFixture.facts, rejected: [] } }]);
  });

  it("starts while a CV tailor task holds the Figma lock (it never needs it)", async () => {
    const t = await createTestEngine();
    let seen: { lock: number | null; status: string | undefined; taskId: number } | null = null;
    t.runner.script({
      bot: "cv",
      kind: "tailor",
      times: 1,
      result: (task: RunnerTask) => {
        const { taskId } = t.engine.enqueueFactDraft(INPUT);
        seen = { lock: t.engine.queue.locks().figma, status: getTask(t.db, taskId)?.status, taskId };
        return defaultFakeResult(task);
      },
    });
    t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    expect(seen).not.toBeNull();
    const s = seen! as { lock: number | null; status: string | undefined; taskId: number };
    expect(s.lock).toBe(t.tasks("cv.tailor")[0]!.id);
    expect(s.status).toBe("running");
    expect(getTask(t.db, s.taskId)?.status).toBe("done");
  });

  it("rejects a drafted fact with a number or tool Ba did not write (the invented-detail guard)", async () => {
    const { sink, calls } = recordingSink();
    const t = await createTestEngine({ factDrafts: sink });
    const invented = { ...factDraftOutputFixture.facts[0]!, id: "grad-3", text: "Cut AWS costs by 40% with Kubernetes." };
    t.runner.script({ bot: "cv", kind: "fact_draft", result: fake.ok(withSelfCheck({ ...factDraftOutputFixture, facts: [factDraftOutputFixture.facts[0]!, invented] })) });
    const { taskId } = t.engine.enqueueFactDraft(INPUT);
    await t.idle();
    const done = calls[0]!;
    expect(done.kind).toBe("done");
    if (done.kind !== "done") return;
    expect(done.result.accepted.map((f) => f.id)).toEqual(["grad-2"]);
    expect(done.result.rejected).toEqual([{ id: "grad-3", text: invented.text, reasons: ["the number 40 is not in your words", "“Kubernetes” is not in your words"] }]);
    // Audited, never streamed.
    expect(listEvents(t.db, { taskId, types: [FACT_DRAFT_REJECTED_EVENT] })).toHaveLength(1);
    t.checkEvents();
  });

  it("passes zero facts and CV's note through when Ba said no", async () => {
    const { sink, calls } = recordingSink();
    const t = await createTestEngine({ factDrafts: sink });
    t.runner.script({ bot: "cv", kind: "fact_draft", result: fake.ok(factDraftNoneFixture) });
    t.engine.enqueueFactDraft({ ...INPUT, text: "No, I haven't." });
    await t.idle();
    expect(calls[0]).toMatchObject({ kind: "done", result: { accepted: [], rejected: [], output: { notes: factDraftNoneFixture.notes } } });
  });

  it("an invalid output fails the attempt (retried once); the sink hears once, and Lead posts nothing", async () => {
    const { sink, calls } = recordingSink();
    const t = await createTestEngine({ factDrafts: sink });
    t.runner.script({ bot: "cv", kind: "fact_draft", result: fake.ok({ facts: [{ id: "Not A Slug" }], notes: null, selfCheck: [], memoryNotes: [] }) });
    const { taskId } = t.engine.enqueueFactDraft(INPUT);
    await t.idle();
    expect(getTask(t.db, taskId)).toMatchObject({ status: "failed", attempt: 2, error: expect.stringMatching(/invalid output/) });
    expect(calls).toEqual([{ kind: "failed", taskId, error: expect.stringMatching(/invalid output/) }]);
    expect(listMessages(t.db, getOrCreateLeadRoom(t.db).id)).toEqual([]);
  });

  it("a sink that throws rolls the result back: the task fails as an engine error and the sink hears it", async () => {
    const { sink, calls } = recordingSink({ throwOnDone: true });
    const t = await createTestEngine({ factDrafts: sink });
    const { taskId } = t.engine.enqueueFactDraft(INPUT);
    await t.idle();
    expect(getTask(t.db, taskId)).toMatchObject({ status: "failed", error: expect.stringMatching(/engine error: sink bug/) });
    expect(calls.map((c) => c.kind)).toEqual(["done", "failed"]);
  });

  it("waits out a usage limit on CV's engine (UC-16)", async () => {
    const t = await createTestEngine({ clock: new FakeClock(T0) });
    t.db.transaction((tx) => t.engine.pauseEngineForLimit(tx, "claude", new Date(T0.getTime() + HOUR).toISOString()));
    const { taskId } = t.engine.enqueueFactDraft(INPUT);
    await t.idle();
    expect(getTask(t.db, taskId)?.status).toBe("waiting_limit");
    t.clock.advance(HOUR);
    await t.idle();
    expect(getTask(t.db, taskId)?.status).toBe("done");
  });

  it("the FakeRunner's default draft is Ba's own sentence, so it passes the guard", () => {
    const out = fakeFactDraft(INPUT);
    expect(out.facts).toEqual([
      expect.objectContaining({ id: "grad-2", type: "experience", org: "Gradion", dates: "2022 – present", text: "At Gradion I deployed our Next.js apps to AWS ECS with Terraform." }),
    ]);
    expect(fakeFactDraft({ ...INPUT, text: "No, never." }).facts).toEqual([]);
  });
});
