// Event invariants (§10.2 rule 8 audit log, §11 SSE live updates and replay). The harness checks
// them on every `t.idle()`, so every engine test is also a property test over its own run:
// - every row whose type is a shared AppEvent type validates (mappers.toAppEvent never drops it);
//   any other row is a known audit-only type;
// - subscribers get exactly the replayable events, valid, in id order;
// - replay(afterId) returns the same events after any id.
import { AppEventSchema } from "@bs-job-agents/shared";
import { describe, expect, it } from "vitest";
import { appendEvent, listEvents } from "../db/index.js";
import { fake } from "./testing/fake-runner.js";
import { AUDIT_ONLY_EVENT_TYPES, createTestEngine } from "./testing/harness.js";

describe("events: what the engine emits validates and replays in order (§10.2 rule 8, §11)", () => {
  it("a busy run (fan-out, a retry, a usage limit, a pause, Ba's decisions, Apply, the record) keeps every invariant", async () => {
    const t = await createTestEngine({ sources: ["itviec", "topcv", "linkedin"] });
    t.runner.script({ bot: "research", kind: "scan", times: 1, when: (task) => (task.input as { source: string }).source === "linkedin", result: fake.needsLogin("linkedin.com") });
    t.runner.script({ bot: "research", kind: "company", times: 1, result: fake.failed("first attempt crashed") });
    t.runner.script({ bot: "qa", kind: "review", times: 1, result: fake.usageLimit("codex", "2026-10-10T09:00:00.000Z") });
    const run = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    // UC-03 a: the LinkedIn branch waits for Ba's login; the fan-out waits for it.
    const linkedin = t.tasks("research.scan").find((x) => x.status === "paused")!;
    t.engine.resumeTask(linkedin.id);
    await t.idle();
    // UC-16: QA hit the limit; Codex resumes by itself at the reset.
    expect(t.tasks("qa.review").some((x) => x.status === "waiting_limit")).toBe(true);
    t.clock.advanceTo("2026-10-10T09:00:01.000Z");
    await t.idle();
    const card = t.review(run.id, 1)!;
    t.engine.approve(1, { cvVersionId: card.cvVersions[0]!.cvVersionId, introText: null });
    await t.idle();

    const delivered = t.delivered();
    const types = new Set(delivered.map((e) => e.type));
    for (const type of ["run.started", "step.started", "task.started", "task.progress", "task.paused", "task.resumed", "task.finished", "engine.paused", "engine.resumed", "review.ready", "application.updated"]) {
      expect(types, type).toContain(type);
    }
    for (const e of delivered) expect(AppEventSchema.safeParse(e).success, e.type).toBe(true);
    // replay(afterId) is the suffix after any id, in order (SSE Last-Event-ID).
    const ids = delivered.map((e) => Number(e.id));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    for (const k of [0, ids[0]!, ids[Math.floor(ids.length / 2)]!, ids.at(-1)!]) {
      expect(t.engine.replay(k).map((r) => r.event)).toEqual(delivered.filter((e) => Number(e.id) > k));
    }
    // Audit-only rows (the spawned CLI's pid, UC-18) are kept but never streamed.
    const audit = listEvents(t.db).filter((r) => (AUDIT_ONLY_EVENT_TYPES as readonly string[]).includes(r.type));
    expect(audit.length).toBeGreaterThan(0);
    expect(delivered.some((e) => (AUDIT_ONLY_EVENT_TYPES as readonly string[]).includes(e.type))).toBe(false);
  });

  it("the check catches a shared-typed row that would never reach the UI, and an unknown type", async () => {
    const t = await createTestEngine();
    appendEvent(t.db, { type: "safety.denied", payload: { botName: "apply", reason: "not-a-reason" } });
    expect(() => t.checkEvents()).toThrow(/safety\.denied.*never reach the UI/);
    const u = await createTestEngine();
    appendEvent(u.db, { type: "task.exploded", payload: {} });
    expect(() => u.checkEvents()).toThrow(/unknown type task\.exploded/);
  });
});
