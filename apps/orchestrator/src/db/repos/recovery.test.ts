import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, openTestDb, type Db } from "../client.js";
import { toAppEvent } from "../mappers.js";
import { at, seedBots, seedRun, seedTask } from "../test-helpers.js";
import { listEvents } from "./events.js";
import { recoverInterruptedTasks } from "./recovery.js";
import { claimNextTask, completeTask, getTask, requeueTask } from "./tasks.js";

let db: Db;
beforeEach(() => {
  db = openTestDb();
  seedBots(db);
});

describe("recoverInterruptedTasks (UC-18)", () => {
  it("re-queues running tasks as a new attempt and leaves others alone", () => {
    const ctx = seedRun(db);
    const running = seedTask(db, ctx, {}, at(1));
    const done = seedTask(db, ctx, {}, at(2));
    const queued = seedTask(db, ctx, {}, at(3));
    claimNextTask(db); // running
    claimNextTask(db); // done
    completeTask(db, done.id, { output: {} });

    const r = recoverInterruptedTasks(db, { now: at(10) });
    expect(r.requeued.map((t) => t.id)).toEqual([running.id]);
    expect(r.needsCheck).toEqual([]);
    expect(r.exhausted).toEqual([]);
    expect(getTask(db, running.id)).toMatchObject({ status: "queued", attempt: 2, startedAt: null });
    expect(getTask(db, done.id)?.status).toBe("done");
    expect(getTask(db, queued.id)?.status).toBe("queued");
    // The audit row is the shared SSE event, so the UI learns about it on replay.
    const events = listEvents(db, { types: ["task.finished"] });
    expect(events.map((e) => e.taskId)).toEqual([running.id]);
    expect(toAppEvent(events[0]!)).toMatchObject({
      type: "task.finished",
      taskId: String(running.id),
      runId: String(ctx.run.id),
      status: "interrupted",
      attempt: 1,
      error: "interrupted by restart",
      at: at(10).toISOString(),
    });
  });

  it("never re-queues an interrupted apply.submit: it stays interrupted for needs_check", () => {
    const ctx = seedRun(db);
    const apply = seedTask(db, ctx, { botName: "apply", kind: "submit", engine: "claude", usesBrowser: true });
    claimNextTask(db);
    const r = recoverInterruptedTasks(db);
    expect(r.needsCheck.map((t) => t.id)).toEqual([apply.id]);
    expect(r.requeued).toEqual([]);
    expect(getTask(db, apply.id)?.status).toBe("interrupted");
  });

  it("fails tasks that have no attempts left", () => {
    const ctx = seedRun(db);
    const t = seedTask(db, ctx);
    claimNextTask(db);
    requeueTask(db, t.id, { newAttempt: true }); // attempt 2
    claimNextTask(db);
    const r = recoverInterruptedTasks(db, { maxAttempts: 2 });
    expect(r.exhausted.map((x) => x.id)).toEqual([t.id]);
    expect(getTask(db, t.id)).toMatchObject({ status: "failed", error: "interrupted by restart; no attempts left" });
  });

  it("works across a real restart of a file database", () => {
    const dir = mkdtempSync(join(tmpdir(), "bsja-recover-"));
    try {
      const path = join(dir, "app.db");
      const before = openDb(path);
      seedBots(before);
      const ctx = seedRun(before);
      const t = seedTask(before, ctx);
      claimNextTask(before);
      before.$client.close(); // "crash"

      const after = openDb(path);
      const r = recoverInterruptedTasks(after);
      expect(r.requeued.map((x) => x.id)).toEqual([t.id]);
      expect(claimNextTask(after)?.id).toBe(t.id);
      after.$client.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
