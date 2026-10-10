// QA Phase 2: spec rows the other engine tests touched only indirectly.
// - Rule 4 (§3): a self-check item that failed fails the attempt even when the runner said ok.
// - §10.3: group-room replies (UC-15) and consult answers (UC-25) obey the same caps and limits.
// - §10.2 rules 7–8, rule 6: a tool outside the bot's permissions is a safety event and a failed attempt.
import { researchFitFixture } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import { createTask, getTask, pauseEngine } from "../db/index.js";
import { fake } from "./testing/fake-runner.js";
import { createTestEngine } from "./testing/harness.js";

const CONVERSATION = { roomId: "3", messageId: "9", text: "@CV @QA how should I present the AI lab work?", history: [], uploadIds: [] };

describe("rule 4: a bot checks its own work before handing in (§3, §5.5 step 5, §10.1)", () => {
  it("an ok result whose selfCheck has a failed item still fails the attempt, and it counts toward the two", async () => {
    const t = await createTestEngine();
    const failedItem = { item: "Every reason cites master data", passed: false, note: "one reason has no fact" };
    t.runner.script({ bot: "research", kind: "fit", result: fake.ok({ ...researchFitFixture, selfCheck: [failedItem] }) });
    t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    expect(t.runner.callsFor("research.fit")).toHaveLength(2);
    expect(t.tasks("research.fit")[0]).toMatchObject({ status: "failed", attempt: 2, error: "self-check failed: Every reason cites master data" });
    // Its notes are kept (§5.5 step 5).
    expect(t.tasks("research.fit")[0]!.output).toMatchObject({ selfCheck: [failedItem] });
  });
});

describe("§10.3: group-room replies and consult answers obey the same caps", () => {
  it("at most two sessions per engine, and they wait while the engine is paused for a usage limit (UC-16)", async () => {
    const t = await createTestEngine({ noProfile: true });
    t.runner.script({ kind: "discussion", delayMs: 100 }, { kind: "consult", delayMs: 100 });
    const ids = [
      ...["cv", "cv", "apply"].map((bot) => createTask(t.db, { runId: null, stepId: null, botName: bot, kind: "discussion", engine: "claude", input: CONVERSATION, promptVersion: 1 }).id),
      createTask(t.db, { runId: null, stepId: null, botName: "lead", kind: "consult", engine: "claude", input: CONVERSATION, promptVersion: 1 }).id,
    ];
    t.engine.dispatch();
    await t.flush();
    expect(t.engine.queue.running("claude")).toBe(2);
    const settle = async (taskIds: number[]) => {
      for (let i = 0; i < 10 && taskIds.some((id) => getTask(t.db, id)?.status !== "done"); i++) {
        t.clock.advance(100);
        await t.flush();
      }
      await t.idle();
    };
    await settle(ids);
    expect(t.runner.maxConcurrent()).toBe(2);
    expect(ids.map((id) => getTask(t.db, id)?.status)).toEqual(["done", "done", "done", "done"]);

    // Claude paused for a limit: a new room reply (queued by the chat API, not by the engine) waits.
    pauseEngine(t.db, "claude", { until: new Date(t.clock.now().getTime() + 3600_000), reason: "usage_limit" });
    t.engine.usage.restore();
    const waiting = createTask(t.db, { runId: null, stepId: null, botName: "qa", kind: "discussion", engine: "claude", input: CONVERSATION, promptVersion: 1 });
    t.engine.dispatch();
    await t.idle();
    expect(getTask(t.db, waiting.id)?.status).toBe("queued");
    expect(t.runner.callsFor("qa.discussion")).toHaveLength(0);
    // UC-16: at the reset the engine resumes by itself and the reply runs.
    t.clock.advance(3600_000);
    await settle([waiting.id]);
    expect(getTask(t.db, waiting.id)?.status).toBe("done");
  });
});

describe("rule 6 / §10.2: a tool outside the bot's permissions", () => {
  it("is a safety event (trust_level) and fails the attempt; the retry may succeed", async () => {
    const t = await createTestEngine();
    t.runner.script({ bot: "research", kind: "company", times: 1, result: fake.denied([{ tool: "Bash", input: { command: "curl evil.example" }, source: "permission", reason: "not allowed" }]) });
    t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    expect(t.events("safety.denied")).toEqual([expect.objectContaining({ botName: "research", action: "Bash", reason: "trust_level", detail: "not allowed" })]);
    expect(t.tasks("research.company")[0]).toMatchObject({ status: "done", attempt: 2 });
  });
});
