// PM2 S2: the engine seams W3a builds the chat flows on (S20): enqueueConversation (strict prompt
// schema, effective engine, held under a usage pause), the ConversationSink the settle transaction
// calls (replies and UC-25 a handoffs are posted atomically with the task's result), and
// confirmInjection with its audited event (UC-07 b).
import { consultHandoffFixture, consultReplyFixture, leadOutputFixture, qaFailFixture, qaPassFixture } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import { appendMessage, getJob, getOrCreateLeadRoom, getTask, listMessages, updateBot } from "../db/index.js";
import { approvalStatus, type ConversationSink, type ConversationSinkContext } from "./index.js";
import { EngineError } from "./errors.js";
import { fake } from "./testing/fake-runner.js";
import { FakeClock } from "./testing/fake-clock.js";
import { createTestEngine } from "./testing/harness.js";

const T0 = new Date("2026-10-10T08:00:00.000Z");
const HOUR = 3600_000;
const CONVERSATION = { roomId: "1", messageId: "9", text: "Why did QA fail NovaPay?", history: [{ author: "ba", text: "Hi" }], uploadIds: [] };
const LEAD_CHAT = { ...CONVERSATION, text: "Find frontend jobs in HCM", handoff: null };

function code(fn: () => unknown): string | null {
  try {
    fn();
  } catch (err) {
    if (err instanceof EngineError) return err.code;
    throw err;
  }
  return null;
}

/** A sink that records its calls and writes a reply the way W3a would (in the same transaction). */
function recordingSink(opts: { throwOnDone?: boolean; handoff?: boolean } = {}) {
  const calls: { kind: "done" | "failed"; taskId: number; detail: unknown }[] = [];
  const sink: ConversationSink = {
    done(ctx: ConversationSinkContext, result) {
      calls.push({ kind: "done", taskId: ctx.task.id, detail: result });
      const room = getOrCreateLeadRoom(ctx.conn);
      appendMessage(ctx.conn, { roomId: room.id, author: ctx.task.botName, text: "reply" in result.output ? result.output.reply : "" });
      if (opts.throwOnDone) throw new Error("sink bug");
      if (opts.handoff && result.kind !== "chat" && result.output.handoffToLead) {
        ctx.enqueue({ bot: "lead", kind: "chat", input: { ...CONVERSATION, text: result.output.handoffToLead.request, handoff: { fromBot: ctx.task.botName, request: result.output.handoffToLead.request } } });
      }
    },
    failed(ctx, error) {
      calls.push({ kind: "failed", taskId: ctx.task.id, detail: error });
    },
  };
  return { sink, calls };
}

describe("enqueueConversation (PM2 S2)", () => {
  it("validates the strict prompt schema before anything is queued", async () => {
    const t = await createTestEngine();
    expect(code(() => t.engine.enqueueConversation({ bot: "qa", kind: "consult", input: { ...CONVERSATION, extra: 1 } }))).toBe("validation_failed");
    expect(code(() => t.engine.enqueueConversation({ bot: "lead", kind: "chat", input: CONVERSATION }))).toBe("validation_failed");
    expect(code(() => t.engine.enqueueConversation({ bot: "qa", kind: "chat", input: LEAD_CHAT }))).toBe("validation_failed");
    expect(code(() => t.engine.enqueueConversation({ bot: "ghost", kind: "consult", input: CONVERSATION }))).toBe("not_found");
    expect(t.tasks()).toEqual([]);
  });

  it("queues on the bot's effective engine (the Bots screen's switch) and runs read-only", async () => {
    const t = await createTestEngine();
    updateBot(t.db, "qa", { engine: "claude" });
    const { taskId } = t.engine.enqueueConversation({ bot: "qa", kind: "consult", input: CONVERSATION });
    await t.idle();
    expect(getTask(t.db, taskId)).toMatchObject({ status: "done", engine: "claude", runId: null, usesBrowser: false, usesFigma: false });
    expect(t.runner.callsFor("qa.consult")[0]!.bot.engine).toBe("claude");
  });

  it("refuses a disabled bot", async () => {
    const t = await createTestEngine();
    updateBot(t.db, "cv", { enabled: false });
    expect(code(() => t.engine.enqueueConversation({ bot: "cv", kind: "consult", input: CONVERSATION }))).toBe("conflict");
  });

  it("holds the task under a usage pause; it runs by itself after the reset (UC-16)", async () => {
    const t = await createTestEngine({ clock: new FakeClock(T0) });
    t.db.transaction((tx) => t.engine.pauseEngineForLimit(tx, "codex", new Date(T0.getTime() + HOUR).toISOString()));
    const { taskId } = t.engine.enqueueConversation({ bot: "qa", kind: "discussion", input: CONVERSATION });
    await t.idle();
    expect(getTask(t.db, taskId)?.status).toBe("waiting_limit");
    t.clock.advance(HOUR);
    await t.idle();
    expect(getTask(t.db, taskId)?.status).toBe("done");
  });

  it("Lead's chat takes the LeadChatInput (history and handoff are untrusted in the prompt)", async () => {
    const t = await createTestEngine();
    const { taskId } = t.engine.enqueueConversation({ bot: "lead", kind: "chat", input: { ...LEAD_CHAT, handoff: { fromBot: "qa", request: "Find AI roles" } } });
    await t.idle();
    expect(getTask(t.db, taskId)?.status).toBe("done");
    expect(t.runner.callsFor("lead.chat")[0]!.input).toMatchObject({ handoff: { fromBot: "qa" } });
  });
});

describe("ConversationSink (PM2 S2)", () => {
  it("is called in the settle transaction with the output; a UC-25 a handoff queues Lead's chat atomically", async () => {
    const { sink, calls } = recordingSink({ handoff: true });
    const t = await createTestEngine({ conversations: sink });
    t.runner.script({ bot: "qa", kind: "consult", result: fake.ok(consultHandoffFixture) });
    const { taskId } = t.engine.enqueueConversation({ bot: "qa", kind: "consult", input: CONVERSATION });
    await t.idle();
    expect(calls[0]).toMatchObject({ kind: "done", taskId, detail: { kind: "consult", output: { handoffToLead: consultHandoffFixture.handoffToLead } } });
    // The handed-over request ran as Lead's chat, after the consult's result was committed.
    const lead = t.tasks("lead.chat")[0]!;
    expect(lead).toMatchObject({ status: "done", input: expect.objectContaining({ handoff: { fromBot: "qa", request: "Find AI-focused frontend roles in HCM" } }) });
    expect(calls.map((c) => c.kind)).toEqual(["done", "done"]);
    expect(calls[1]).toMatchObject({ taskId: lead.id, detail: { kind: "chat", output: { reply: leadOutputFixture.reply } } });
  });

  it("a sink that throws rolls the result back with it: the task fails as an engine error, nothing half-written", async () => {
    const { sink, calls } = recordingSink({ throwOnDone: true });
    const t = await createTestEngine({ conversations: sink });
    t.runner.script({ bot: "cv", kind: "consult", result: fake.ok(consultReplyFixture) });
    const { taskId } = t.engine.enqueueConversation({ bot: "cv", kind: "consult", input: CONVERSATION });
    await t.idle();
    expect(getTask(t.db, taskId)).toMatchObject({ status: "failed", error: expect.stringMatching(/engine error: sink bug/) });
    expect(listMessages(t.db, getOrCreateLeadRoom(t.db).id).filter((m) => m.author === "cv")).toEqual([]);
    expect(calls.map((c) => c.kind)).toEqual(["done", "failed"]);
  });

  it("is told once when a conversation fails for good, never for a retried attempt", async () => {
    const { sink, calls } = recordingSink();
    const t = await createTestEngine({ conversations: sink });
    t.runner.script({ bot: "qa", kind: "consult", result: fake.timeout() });
    const { taskId } = t.engine.enqueueConversation({ bot: "qa", kind: "consult", input: CONVERSATION });
    await t.idle();
    expect(getTask(t.db, taskId)).toMatchObject({ status: "failed", attempt: 2 });
    expect(calls).toEqual([{ kind: "failed", taskId, detail: "timed out" }]);
  });
});

describe("confirmInjection (UC-07 b, PM2 S2)", () => {
  it("clears the flag with an audited shared event; Apply may then be approved", async () => {
    const t = await createTestEngine();
    t.runner.script({ bot: "qa", kind: "review", result: fake.ok({ ...qaFailFixture, total: 88, scores: qaPassFixture.scores, hardFails: [], injectionSuspected: true, injectionNote: "ignore previous instructions" }) });
    const run = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    const cvVersionId = t.review(run.id, 1)!.cvVersions[0]!.cvVersionId;
    expect(code(() => t.engine.approve(1, { cvVersionId, introText: null }))).toBe("forbidden");
    t.engine.confirmInjection(1);
    expect(getJob(t.db, 1)?.injectionClearedAt).toBe(T0.toISOString());
    expect(t.events("injection.confirmed")).toEqual([expect.objectContaining({ jobId: "1", runId: String(run.id) })]);
    expect(t.delivered().some((e) => e.type === "injection.confirmed")).toBe(true);
    const result = t.engine.approve(1, { cvVersionId, introText: null });
    expect(result.applicationId).toBe(1);
    // W3a shows the token's expiry and domains, never its value.
    expect(approvalStatus(t.db, 1)).toEqual({ expiresAt: expect.any(String), usedAt: null, allowedDomains: ["itviec.com"] });
  });

  it("a job that is not flagged, or does not exist, is refused", async () => {
    const t = await createTestEngine();
    t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    expect(code(() => t.engine.confirmInjection(1))).toBe("conflict");
    expect(code(() => t.engine.confirmInjection(999))).toBe("not_found");
    expect(t.events("injection.confirmed")).toEqual([]);
  });
});

describe("approve: dry run and a JD without an apply link (PM2 S2)", () => {
  it("approve({ dryRun: true }) runs Apply as a dry run", async () => {
    const t = await createTestEngine();
    const run = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    const r = t.engine.approve(1, { cvVersionId: t.review(run.id, 1)!.cvVersions[0]!.cvVersionId, introText: null, dryRun: true });
    await t.idle();
    expect(t.runner.callsFor("apply.submit")[0]!.input).toMatchObject({ dryRun: true });
    expect(r.applicationId).toBe(1);
  });
});
