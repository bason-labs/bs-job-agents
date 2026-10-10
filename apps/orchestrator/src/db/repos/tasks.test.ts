import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, openTestDb, type Db } from "../client.js";
import { InvalidTransitionError } from "../errors.js";
import { at, seedBots, seedRun, seedTask, T0 } from "../test-helpers.js";
import { pauseEngine } from "./engine-state.js";
import { updateRunStatus } from "./runs.js";
import {
  claimNextTask,
  completeTask,
  countTasks,
  createTask,
  failTask,
  getTask,
  holdEngineTasks,
  listTasks,
  pauseTask,
  releaseEngineTasks,
  requeueTask,
  setTaskTranscriptPath,
} from "./tasks.js";

let db: Db;
beforeEach(() => {
  db = openTestDb();
  seedBots(db);
});

describe("tasks: create and lifecycle", () => {
  it("creates a queued task at attempt 1", () => {
    const ctx = seedRun(db);
    const task = seedTask(db, ctx, { usesBrowser: true, promptVersion: 3 });
    expect(task).toMatchObject({
      status: "queued",
      attempt: 1,
      engine: "codex",
      usesBrowser: true,
      usesFigma: false,
      promptVersion: 3,
      input: { source: "topcv" },
      createdAt: T0.toISOString(),
    });
    expect(listTasks(db, { runId: ctx.run.id })).toHaveLength(1);
    expect(listTasks(db, { stepId: ctx.step.id, status: "queued" })).toHaveLength(1);
  });

  it("completes and fails only running tasks", () => {
    const ctx = seedRun(db);
    const t = seedTask(db, ctx);
    expect(() => completeTask(db, t.id, { output: {} })).toThrow(InvalidTransitionError);
    claimNextTask(db, { now: at(1) });
    setTaskTranscriptPath(db, t.id, `data/transcripts/${t.id}.jsonl`);
    const done = completeTask(db, t.id, { output: { jobs: [] }, now: at(9) });
    expect(done).toMatchObject({
      status: "done",
      output: { jobs: [] },
      startedAt: at(1).toISOString(),
      finishedAt: at(9).toISOString(),
      transcriptPath: `data/transcripts/${t.id}.jsonl`,
    });
    expect(() => completeTask(db, t.id, { output: {} })).toThrow(InvalidTransitionError);

    const t2 = seedTask(db, ctx);
    claimNextTask(db);
    expect(failTask(db, t2.id, { error: "timeout" })).toMatchObject({ status: "failed", error: "timeout" });
  });

  it("pauses with a reason and requeues as a new attempt", () => {
    const ctx = seedRun(db);
    const t = seedTask(db, ctx);
    claimNextTask(db);
    expect(pauseTask(db, t.id, { code: "needs_login", site: "topcv.vn", detail: null })).toMatchObject({
      status: "paused",
      pauseReason: "needs_login(topcv.vn)",
    });
    const same = requeueTask(db, t.id);
    expect(same).toMatchObject({ status: "queued", attempt: 1, pauseReason: null, startedAt: null });
    claimNextTask(db);
    const retry = requeueTask(db, t.id, { newAttempt: true });
    expect(retry.attempt).toBe(2);
  });

  it("only stores pause reasons the shared schema accepts (UC-17: login and CAPTCHA name the site)", () => {
    const ctx = seedRun(db);
    const t = seedTask(db, ctx);
    claimNextTask(db);
    expect(() => pauseTask(db, t.id, { code: "needs_login", site: null, detail: null })).toThrow();
    expect(() => pauseTask(db, t.id, { code: "rate_limited" as "usage_limit", site: null, detail: null })).toThrow();
    expect(getTask(db, t.id)?.status).toBe("running");
    expect(pauseTask(db, t.id, { code: "needs_figma", site: null, detail: "bridge not running" }).pauseReason).toBe("needs_figma");
  });

  it("refuses to requeue finished tasks", () => {
    const ctx = seedRun(db);
    const t = seedTask(db, ctx);
    claimNextTask(db);
    completeTask(db, t.id, { output: {} });
    expect(() => requeueTask(db, t.id)).toThrow(InvalidTransitionError);
  });
});

describe("claimNextTask", () => {
  it("claims the oldest queued task and marks it running", () => {
    const ctx = seedRun(db);
    const first = seedTask(db, ctx, {}, at(1));
    seedTask(db, ctx, {}, at(2));
    const claimed = claimNextTask(db, { now: at(5) });
    expect(claimed?.id).toBe(first.id);
    expect(claimed).toMatchObject({ status: "running", startedAt: at(5).toISOString() });
    expect(getTask(db, first.id)?.status).toBe("running");
  });

  it("returns undefined when nothing is runnable", () => {
    expect(claimNextTask(db)).toBeUndefined();
  });

  it("claims consult and discussion tasks, which have no run, under the same caps (UC-15, UC-25, §10.3)", () => {
    const ctx = seedRun(db);
    updateRunStatus(db, ctx.run.id, "paused");
    seedTask(db, ctx, {}, at(1));
    const consult = createTask(
      db,
      { runId: null, stepId: null, botName: "qa", kind: "consult", engine: "codex", promptVersion: 1, input: { text: "why did QA fail NovaPay?" } },
      { now: at(2) },
    );
    expect(consult).toMatchObject({ runId: null, stepId: null, status: "queued" });
    // The paused run's task is skipped; the run-less consult task is claimable.
    expect(claimNextTask(db, { now: at(3) })?.id).toBe(consult.id);
    // Engine pauses still apply to it (UC-16).
    const later = createTask(db, { runId: null, stepId: null, botName: "cv", kind: "discussion", engine: "claude", promptVersion: 1, input: {} }, { now: at(4) });
    pauseEngine(db, "claude", { until: at(60), reason: "usage_limit" });
    expect(claimNextTask(db, { now: at(5) })).toBeUndefined();
    expect(claimNextTask(db, { now: at(61) })?.id).toBe(later.id);
  });

  it("respects engine, bot and kind filters", () => {
    const ctx = seedRun(db);
    seedTask(db, ctx, { botName: "research", engine: "codex" }, at(1));
    const cv = seedTask(db, ctx, { botName: "cv", kind: "tailor", engine: "claude" }, at(2));
    expect(claimNextTask(db, { engines: ["claude"] })?.id).toBe(cv.id);
    expect(claimNextTask(db, { botNames: ["qa"] })).toBeUndefined();
    expect(claimNextTask(db, { kinds: ["scan"] })?.botName).toBe("research");
  });

  it("skips browser / Figma tasks while those locks are held (§10.3)", () => {
    const ctx = seedRun(db);
    seedTask(db, ctx, { usesBrowser: true }, at(1));
    seedTask(db, ctx, { botName: "cv", kind: "tailor", engine: "claude", usesFigma: true }, at(2));
    const plain = seedTask(db, ctx, { input: { source: "search-only" } }, at(3));
    expect(claimNextTask(db, { allowBrowser: false, allowFigma: false })?.id).toBe(plain.id);
    expect(claimNextTask(db, { allowBrowser: false })?.usesFigma).toBe(true);
    expect(claimNextTask(db)?.usesBrowser).toBe(true);
  });

  it("skips tasks of paused, cancelled or finished runs", () => {
    const ctx = seedRun(db);
    seedTask(db, ctx);
    updateRunStatus(db, ctx.run.id, "paused");
    expect(claimNextTask(db)).toBeUndefined();
    updateRunStatus(db, ctx.run.id, "waiting");
    expect(claimNextTask(db)).toBeDefined();
  });

  it("skips engines paused for a usage limit until the reset time (UC-16)", () => {
    const ctx = seedRun(db);
    seedTask(db, ctx, { engine: "claude", botName: "cv", kind: "tailor" });
    pauseEngine(db, "claude", { until: at(60), reason: "usage_limit" });
    expect(claimNextTask(db, { now: at(10) })).toBeUndefined();
    expect(claimNextTask(db, { now: at(10), respectEnginePause: false })).toBeDefined();
  });

  it("claims again once the pause has expired", () => {
    const ctx = seedRun(db);
    seedTask(db, ctx, { engine: "claude", botName: "cv", kind: "tailor" });
    pauseEngine(db, "claude", { until: at(60), reason: "usage_limit" });
    expect(claimNextTask(db, { now: at(61) })).toBeDefined();
  });

  it("never claims a task twice across two connections to the same file", () => {
    const dir = mkdtempSync(join(tmpdir(), "bsja-claim-"));
    try {
      const path = join(dir, "app.db");
      const a = openDb(path);
      const b = openDb(path);
      seedBots(a);
      const ctx = seedRun(a);
      for (let i = 0; i < 20; i++) seedTask(a, ctx, {}, at(i));
      const seen: number[] = [];
      for (;;) {
        const x = claimNextTask(a);
        const y = claimNextTask(b);
        if (x) seen.push(x.id);
        if (y) seen.push(y.id);
        if (!x && !y) break;
      }
      expect(seen).toHaveLength(20);
      expect(new Set(seen).size).toBe(20);
      a.$client.close();
      b.$client.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("claimNextTask under two concurrent processes", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("no task is double-claimed", async () => {
    dir = mkdtempSync(join(tmpdir(), "bsja-claim-proc-"));
    const path = join(dir, "app.db");
    const seedDb = openDb(path);
    seedBots(seedDb);
    const ctx = seedRun(seedDb);
    const N = 300;
    seedDb.transaction((tx) => {
      for (let i = 0; i < N; i++) seedTask(tx, ctx, {}, at(i));
    });
    seedDb.$client.close();

    const here = dirname(fileURLToPath(import.meta.url));
    const worker = join(here, "claim-worker.fixture.ts");
    const orchestratorRoot = join(here, "..", "..", "..");

    const runWorker = () => {
      const child = spawn(process.execPath, ["--import", "tsx", worker, path], {
        cwd: orchestratorRoot,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr.on("data", (d: Buffer) => (err += d.toString()));
      const ready = new Promise<void>((resolve) => {
        const onData = (d: Buffer) => {
          if (d.toString().includes("ready")) {
            child.stdout.off("data", onData);
            resolve();
          }
        };
        child.stdout.on("data", onData);
      });
      const done = new Promise<number[]>((resolve, reject) => {
        child.on("exit", (code) => {
          if (code !== 0) return reject(new Error(`worker exited ${code}: ${err}`));
          const line = out.split("\n").find((l) => l.startsWith("ids:"));
          resolve(JSON.parse(line?.slice(4) ?? "[]") as number[]);
        });
      });
      return { child, ready, done };
    };

    const w1 = runWorker();
    const w2 = runWorker();
    await Promise.all([w1.ready, w2.ready]);
    w1.child.stdin.end("go\n");
    w2.child.stdin.end("go\n");
    const [ids1, ids2] = await Promise.all([w1.done, w2.done]);

    const all = [...ids1, ...ids2];
    expect(all).toHaveLength(N);
    expect(new Set(all).size).toBe(N);
    expect(ids1.length).toBeGreaterThan(0);
    expect(ids2.length).toBeGreaterThan(0);

    const check = openDb(path);
    expect(countTasks(check, { status: "running" })).toBe(N);
    check.$client.close();
  }, 30_000);
});

describe("engine holds (UC-16)", () => {
  it("moves queued tasks of an engine to waiting_limit and back", () => {
    const ctx = seedRun(db);
    seedTask(db, ctx, { engine: "claude", botName: "cv", kind: "tailor" });
    seedTask(db, ctx, { engine: "claude", botName: "cv", kind: "tailor" });
    seedTask(db, ctx, { engine: "codex" });
    expect(holdEngineTasks(db, "claude")).toBe(2);
    expect(countTasks(db, { status: "waiting_limit", engine: "claude" })).toBe(2);
    expect(claimNextTask(db, { engines: ["claude"] })).toBeUndefined();
    expect(releaseEngineTasks(db, "claude")).toBe(2);
    expect(countTasks(db, { status: "queued" })).toBe(3);
  });
});
