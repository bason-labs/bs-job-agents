// Owner decision 2026-10-11: Ba may run CV on Codex as an explicit opt-in (bots.engine_risk_ack_at),
// accepting that the Figma guard hook (Claude-only PreToolUse) cannot run there. The engine still
// holds the Figma lock, fingerprints the protected pages before and after, persists "before", and
// fails + demotes + alerts Ba on a protected-page change. Without the opt-in CV on Codex is refused.
import { describe, expect, it } from "vitest";
import { getBot, latestBotDemotion, listEvents, updateBot } from "../db/index.js";
import type { RunnerTask } from "../runner/types.js";
import { FIGMA_BEFORE_EVENT } from "./queue.js";
import { defaultFakeResult } from "./testing/fake-runner.js";
import { createTestEngine, type TestEngine } from "./testing/harness.js";

const scan = { workflow: "job-scan", params: { searchProfileId: null, overrides: null } } as const;
const ACK_AT = "2026-10-11T09:00:00.000Z";

async function cvOnCodex(ack: boolean): Promise<TestEngine> {
  const t = await createTestEngine();
  updateBot(t.db, "cv", { engine: "codex", engineRiskAckAt: ack ? ACK_AT : null });
  return t;
}

describe("CV on Codex (owner decision 2026-10-11)", () => {
  it("without Ba's opt-in the CV task is refused before it spawns (the Figma guard can't run on Codex)", async () => {
    const t = await cvOnCodex(false);
    t.engine.startWorkflow(scan, { trigger: "chat" });
    await t.idle();
    expect(t.runner.callsFor("cv.tailor")).toHaveLength(0);
    expect(t.tasks("cv.tailor")[0]).toMatchObject({ status: "failed", engine: "codex", error: expect.stringMatching(/Figma bridge must run on Claude/) });
  });

  it("with the opt-in: runs on Codex without hook settings, under the Figma lock, fingerprinting before and after", async () => {
    const t = await cvOnCodex(true);
    let lockDuringRun: number | null = null;
    t.runner.script({
      bot: "cv",
      kind: "tailor",
      times: 1,
      result: (task: RunnerTask) => {
        lockDuringRun = t.engine.queue.locks().figma;
        return defaultFakeResult(task);
      },
    });
    t.engine.startWorkflow(scan, { trigger: "chat" });
    await t.idle();
    const call = t.runner.callsFor("cv.tailor")[0]!;
    expect(lockDuringRun).toBe(call.taskId);
    expect(call.bot.engine).toBe("codex");
    expect(call.unguardedFigmaAcknowledged).toBe(true);
    expect(call.hookSettings).toBeUndefined();
    expect(t.guards.figmaCalls).toHaveLength(0);
    // §6.2: the Drafts page, the "before" fingerprint (persisted before the spawn) and the after-check.
    expect(t.figma.calls.filter((c) => c === "fingerprint").length).toBeGreaterThanOrEqual(2);
    expect(listEvents(t.db).filter((e) => e.type === FIGMA_BEFORE_EVENT)).toHaveLength(1);
    expect(t.tasks("cv.tailor")[0]).toMatchObject({ status: "done", engine: "codex", usesFigma: true });
    expect(t.engine.queue.locks().figma).toBeNull();
    t.checkEvents();
  });

  it("a consult with CV on Codex (opted in) runs read-only with the opt-in passed on, and no Figma lock", async () => {
    const t = await cvOnCodex(true);
    const input = { roomId: "1", messageId: "9", text: "Why one page?", history: [], uploadIds: [] };
    const { taskId } = t.engine.enqueueConversation({ bot: "cv", kind: "consult", input });
    await t.idle();
    expect(t.tasks().find((x) => x.id === taskId)).toMatchObject({ status: "done", engine: "codex", usesFigma: false });
    expect(t.runner.callsFor("cv.consult")[0]).toMatchObject({ unguardedFigmaAcknowledged: true });
  });

  it("a Claude task never carries the opt-in, even when Ba acknowledged it earlier", async () => {
    const t = await createTestEngine();
    updateBot(t.db, "cv", { engineRiskAckAt: ACK_AT });
    t.engine.startWorkflow(scan, { trigger: "chat" });
    await t.idle();
    const call = t.runner.callsFor("cv.tailor")[0]!;
    expect(call.bot.engine).toBe("claude");
    expect(call.unguardedFigmaAcknowledged).toBeUndefined();
    expect(call.hookSettings?.hooks?.PreToolUse?.map((m) => m.matcher)).toContain("mcp__figma__.*");
  });

  it("a protected-page change on Codex fails the task, demotes CV and alerts Ba with the 'That was me' card", async () => {
    const t = await cvOnCodex(true);
    t.runner.script({
      bot: "cv",
      kind: "tailor",
      times: 1,
      result: (task: RunnerTask) => {
        t.figma.changeProtectedText("Edited on Codex");
        return defaultFakeResult(task);
      },
    });
    t.engine.startWorkflow(scan, { trigger: "chat" });
    await t.idle();
    const cvTask = t.tasks("cv.tailor")[0]!;
    expect(cvTask.status).toBe("failed");
    expect(getBot(t.db, "cv")?.trustLevel).toBe(1);
    expect(latestBotDemotion(t.db, "cv")).toMatchObject({ reason: "protected_page_changed", taskId: cvTask.id });
    const alert = t.events("message.created").find((e) => /by the bot or by you/.test(e.message.text))!;
    expect(alert.message.cards).toContainEqual({ type: "choice", key: `figma-change:${cvTask.id}`, options: [{ id: "was_me", label: "That was me — retry" }], chosen: null });
  });
});
