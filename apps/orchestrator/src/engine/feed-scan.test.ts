// W5: feed sources in job-scan. Remote OK, We Work Remotely, Remotive and Jobspresso are fetched
// by the orchestrator (FeedTaskRunner + deps.feeds): their research.scan tasks never reach a runner
// (no bot, no LLM, no engine session, no usage pause), and their results join the browser sources'
// in the same scan-join → dedupe → fit (LLM) → top steps.
import { readFileSync } from "node:fs";
import { researchScanFixture } from "@bs-job-agents/shared/fixtures";
import type { FeedSource, ResearchScanInput, ResearchScanOutput } from "@bs-job-agents/shared";
import { describe, expect, it } from "vitest";
import { FeedScanner, type FeedFetch } from "../adapters/feeds/index.js";
import { claimNextTask, createTask, getRun, holdEngineTasks, isFeedTask, listJobs, pauseEngine } from "../db/index.js";
import type { FeedScanPort } from "./ports.js";
import type { JoinStepOutput } from "./state.js";
import { createTestEngine } from "./testing/harness.js";

const NOVAPAY = researchScanFixture.jobs[0]!;
const JD = NOVAPAY.jdText;

/** A fake feed port: one job per source (or an error), and the calls it got. */
function fakeFeeds(plan: Partial<Record<FeedSource, "fail" | ResearchScanOutput["jobs"]>> = {}) {
  const calls: { source: FeedSource; input: ResearchScanInput }[] = [];
  const port: FeedScanPort = {
    async scan(source, input) {
      calls.push({ source, input });
      const p = plan[source];
      if (p === "fail") throw new Error(`${source}: https://${source}.example/api answered HTTP 503`);
      const jobs = p ?? [{ ...NOVAPAY, source, url: `https://${source}.example/jobs/1`, company: `Remote Co (${source})`, title: "Frontend Engineer", location: "Remote", workMode: "remote" as const, jdText: JD }];
      return { jobs, pageViews: 0, blocked: null, injectionSuspected: false, injectionNote: null, selfCheck: [{ item: "feed", passed: true, note: null }], memoryNotes: [] };
    },
  };
  return { port, calls };
}

const fixture = (name: string) => readFileSync(new URL(`../adapters/fixtures/${name}`, import.meta.url), "utf8");
const fixtureFetch: FeedFetch = async (url) => {
  const file = url.startsWith("https://remoteok.com/") ? "remoteok-api.json" : url.startsWith("https://weworkremotely.com/") ? "weworkremotely-full-stack.rss" : null;
  if (!file) return { ok: false, status: 404, text: async () => "" };
  const body = fixture(file);
  return { ok: true, status: 200, text: async () => body };
};

const START = { workflow: "job-scan", params: { searchProfileId: null, overrides: null } } as const;

describe("job-scan with feed sources (no bot for them)", () => {
  it("feed sources are fetched by the orchestrator; only the browser source reaches a runner; all join, dedupe and get a fit score", async () => {
    const feeds = fakeFeeds();
    const t = await createTestEngine({ sources: ["itviec", "remoteok", "remotive"], feeds: feeds.port });
    const run = t.engine.startWorkflow(START, { trigger: "chat" });
    await t.idle();

    // One scan task per source on the canvas; the feeds' never went to the runner.
    const scans = t.tasks("research.scan");
    expect(scans.map((x) => [(x.input as { source: string }).source, x.status, x.usesBrowser])).toEqual([
      ["itviec", "done", true],
      ["remoteok", "done", false],
      ["remotive", "done", false],
    ]);
    expect(t.runner.callsFor("research.scan").map((c) => (c.input as { source: string }).source)).toEqual(["itviec"]);
    expect(feeds.calls.map((c) => c.source)).toEqual(["remoteok", "remotive"]);
    // The feed gets research.scan's input: the profile and the candidate limit.
    expect(feeds.calls[0]!.input).toMatchObject({ source: "remoteok", criteria: { roles: ["Frontend Engineer"] }, candidateLimit: 15, maxPageViews: null });

    const join = t.step(run.id, "scan-join")!.output as JoinStepOutput;
    expect(join.results).toHaveLength(3);
    expect(join.failures).toEqual([]);
    // Fit (an LLM task) scores the feeds' jobs like any other.
    const fitCompanies = t.runner.callsFor("research.fit").map((c) => (c.input as { job: { company: string } }).job.company);
    expect(fitCompanies).toEqual(expect.arrayContaining(["Remote Co (remoteok)", "Remote Co (remotive)"]));
    expect(listJobs(t.db).filter((j) => j.source === "remoteok" || j.source === "remotive")).toHaveLength(2);
    // task.started / task.finished for the feed tasks, so the canvas shows them like the others.
    const started = t.events("task.started").map((e) => e.taskId);
    expect(started).toEqual(expect.arrayContaining(scans.map((s) => String(s.id))));
  });

  it("a feed that fails is retried once, then listed as a failed source; the scan goes on with the others (M5-like)", async () => {
    const feeds = fakeFeeds({ remotive: "fail" });
    const t = await createTestEngine({ sources: ["itviec", "remotive"], feeds: feeds.port });
    const run = t.engine.startWorkflow(START, { trigger: "chat" });
    await t.idle();
    expect(feeds.calls.map((c) => c.source)).toEqual(["remotive", "remotive"]);
    const remotive = t.tasks("research.scan").find((x) => (x.input as { source: string }).source === "remotive")!;
    expect(remotive).toMatchObject({ status: "failed", attempt: 2, error: "remotive: https://remotive.example/api answered HTTP 503" });
    const join = t.step(run.id, "scan-join")!.output as JoinStepOutput;
    expect(join.results).toHaveLength(1);
    expect(join.failures).toEqual([expect.objectContaining({ item: "remotive", error: expect.stringMatching(/HTTP 503/) })]);
    expect(t.step(run.id, "review", "1")?.status).toBe("waiting");
  });

  it("with no feed port wired, a feed source fails clearly (and never goes to a bot)", async () => {
    const t = await createTestEngine({ sources: ["itviec", "jobspresso"] });
    t.engine.startWorkflow(START, { trigger: "chat" });
    await t.idle();
    const task = t.tasks("research.scan").find((x) => (x.input as { source: string }).source === "jobspresso")!;
    expect(task).toMatchObject({ status: "failed", error: "feed sources are not wired in this orchestrator (jobspresso)" });
    expect(t.runner.callsFor("research.scan")).toHaveLength(1);
  });

  it("feeds use no engine: they run with every engine at its cap or paused for a usage limit", async () => {
    const feeds = fakeFeeds();
    const t = await createTestEngine({ sources: ["itviec", "remoteok"], feeds: feeds.port, config: { engineCaps: { claude: 0, codex: 0 } } });
    pauseEngine(t.db, "claude", { until: new Date(t.clock.now().getTime() + 3_600_000), reason: "usage_limit" });
    const run = t.engine.startWorkflow(START, { trigger: "chat" });
    await t.idle();
    const [itviec, remoteok] = t.tasks("research.scan");
    expect(remoteok).toMatchObject({ status: "done" });
    expect(itviec!.status).not.toBe("done");
    expect(t.runner.calls).toHaveLength(0);
    expect(getRun(t.db, run.id)?.status).not.toBe("failed");
  });

  it("the db: feed tasks are claimed apart and never held by a usage pause", async () => {
    const t = await createTestEngine({ sources: ["itviec"], start: false });
    const mk = (source: string) =>
      createTask(t.db, { runId: null, stepId: null, botName: "research", kind: "scan", engine: "claude", input: { source }, promptVersion: 1 }, { now: t.clock.now() });
    const bot = mk("itviec");
    const feed = mk("weworkremotely");
    expect(isFeedTask(feed)).toBe(true);
    expect(isFeedTask(bot)).toBe(false);
    expect(holdEngineTasks(t.db, "claude")).toBe(1);
    expect(claimNextTask(t.db, { feedTasks: "exclude", now: t.clock.now() })).toBeUndefined();
    expect(claimNextTask(t.db, { feedTasks: "only", respectEnginePause: false, now: t.clock.now() })?.id).toBe(feed.id);
  });

  it("end to end with the real FeedScanner on captured feeds: the same Lemon.io job on Remote OK and WWR becomes one job", async () => {
    const scanner = new FeedScanner({ fetch: fixtureFetch, sleep: async () => undefined });
    const t = await createTestEngine({
      sources: ["remoteok", "weworkremotely"],
      feeds: scanner,
      profile: { roles: ["Software Engineer (React/Node)"], locations: ["Remote"], seniority: ["mid", "senior"] },
    });
    const run = t.engine.startWorkflow(START, { trigger: "chat" });
    await t.idle();
    expect(t.runner.callsFor("research.scan")).toHaveLength(0);
    const lemon = listJobs(t.db).filter((j) => /react full/i.test(j.title));
    expect(lemon).toHaveLength(1);
    expect(lemon[0]).toMatchObject({ source: "remoteok", location: "Remote", workMode: "remote" });
    const dedupe = t.step(run.id, "dedupe")!.output as { duplicates: number; candidates: number };
    expect(dedupe.duplicates).toBeGreaterThanOrEqual(1);
  });
});
