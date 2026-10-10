import { BotDefinitionSchema, parseBotOutput, resolveOutputSchemaName, type BotDefinition } from "@bs-job-agents/shared";
import { botDefinitionFixtures } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import type { RunnerEvent, RunnerTask } from "../../runner/types.js";
import { FakeClock } from "./fake-clock.js";
import { FakeRunner, defaultFakeResult, fake } from "./fake-runner.js";

const bots = new Map<string, BotDefinition>(botDefinitionFixtures.map((d) => [d.name, BotDefinitionSchema.parse(d)]));

function task(botName: string, kind: string, input: unknown = {}, extra: Partial<RunnerTask> = {}): RunnerTask {
  return {
    taskId: 1,
    runId: 1,
    attempt: 1,
    bot: bots.get(botName)!,
    kind,
    input,
    cwd: `/bots/${botName}`,
    transcriptPath: "/data/transcripts/1-1.jsonl",
    timeoutMs: 600_000,
    ...extra,
  };
}

const SCAN_INPUT = { source: "itviec", criteria: {}, maxPageViews: null };

describe("FakeRunner: scripted results keyed by bot, kind and scenario (§12)", () => {
  it("returns a valid default output for every Phase 1 task key", async () => {
    const runner = new FakeRunner();
    const cases: [string, string, unknown][] = [
      ["research", "scan", SCAN_INPUT],
      ["research", "single", { url: "https://itviec.com/it-jobs/frontend-1" }],
      ["research", "file", { uploadId: "1", path: "/data/tasks/1/jd.pdf", filename: "jd.pdf", mime: "application/pdf" }],
      ["research", "fit", { jobId: "1", job: {}, masterCvVersion: 1 }],
      ["research", "company", { name: "NovaPay", website: null }],
      ["cv", "tailor", { jobId: "7", job: { company: "NovaPay", title: "Senior FE" }, language: "vi", round: 2 }],
      ["qa", "review", {}],
      ["apply", "submit", { pdfPath: "/data/applications/1/BA_HUYNH_NOVAPAY_EN.pdf", pdfSha256: "b".repeat(64), dryRun: false }],
      ["lead", "chat", {}],
      ["qa", "consult", {}],
    ];
    for (const [bot, kind, input] of cases) {
      const r = await runner.run(task(bot, kind, input), () => undefined);
      expect(r.status, `${bot}.${kind}`).toBe("ok");
      const schema = resolveOutputSchemaName(bots.get(bot)!, kind);
      const parsed = parseBotOutput(schema, r.status === "ok" ? r.output : null);
      expect(parsed.success, `${bot}.${kind}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });

  it("defaults follow the task: scan per source, CV frame per language and round, Apply's uploaded file", async () => {
    const scan = defaultFakeResult(task("research", "scan", { ...SCAN_INPUT, source: "topcv" }));
    expect(scan.status === "ok" && (scan.output as { jobs: { source: string }[] }).jobs.map((j) => j.source)).toEqual(["topcv"]);
    const cv = defaultFakeResult(task("cv", "tailor", { jobId: "7", job: { company: "Sao Việt Tech", title: "Frontend" }, language: "vi", round: 2 }));
    expect(cv.status === "ok" && cv.output).toMatchObject({ language: "vi", figmaFrameName: "SAOVIETTECH_FRONTEND-J7_VI_v2" });
    const apply = defaultFakeResult(task("apply", "submit", { pdfPath: "/data/applications/4/BA_HUYNH_X_EN.pdf", pdfSha256: "c".repeat(64), dryRun: true }));
    expect(apply.status === "ok" && apply.output).toMatchObject({
      status: "needs_check",
      uploadedFile: { filename: "BA_HUYNH_X_EN.pdf", sha256: "c".repeat(64) },
    });
  });

  it("the newest matching script wins; `times` and `when` narrow it; others fall back to defaults", async () => {
    const runner = new FakeRunner();
    runner.script({ bot: "research", kind: "fit", result: fake.ok({ fit: { score: 40, reasons: [], gaps: [] }, selfCheck: [], memoryNotes: [] }) });
    runner.script({ bot: "research", kind: "fit", times: 1, scenario: "first fit times out", result: fake.timeout() });
    runner.script({ bot: "research", kind: "scan", when: (t) => (t.input as { source: string }).source === "linkedin", result: fake.needsLogin("linkedin.com") });

    expect((await runner.run(task("research", "fit"), () => undefined)).status).toBe("timeout");
    const second = await runner.run(task("research", "fit"), () => undefined);
    expect(second.status === "ok" && (second.output as { fit: { score: number } }).fit.score).toBe(40);
    const linkedin = await runner.run(task("research", "scan", { ...SCAN_INPUT, source: "linkedin" }), () => undefined);
    expect(linkedin.status === "ok" && linkedin.output).toMatchObject({ jobs: [], blocked: { reason: "needs_login", site: "linkedin.com" } });
    const topcv = await runner.run(task("research", "scan", { ...SCAN_INPUT, source: "topcv" }), () => undefined);
    expect(topcv.status === "ok" && (topcv.output as { blocked: unknown }).blocked).toBeNull();
    expect(runner.calls.map((c) => `${c.bot.name}.${c.kind}`)).toEqual(["research.fit", "research.fit", "research.scan", "research.scan"]);
  });

  it("has a scenario for every error and pause the engine handles", () => {
    expect(fake.timeout().status).toBe("timeout");
    expect(fake.invalidOutput().status).toBe("invalid_output");
    expect(fake.failed("boom")).toMatchObject({ status: "failed", error: "boom" });
    expect(fake.cancelled().status).toBe("cancelled");
    expect(fake.usageLimit("claude", "2026-10-10T14:05:00.000Z")).toMatchObject({ status: "usage_limit", engine: "claude", resetsAt: "2026-10-10T14:05:00.000Z" });
    expect(fake.usageLimit("codex", null)).toMatchObject({ status: "usage_limit", resetsAt: null });
    expect(fake.selfCheckFailed("cv", ["One A4 page"])).toMatchObject({ status: "self_check_failed", failed: ["One A4 page"] });
    expect(fake.denied([{ tool: "mcp__claude-in-chrome__navigate", input: { url: "https://evil.example" }, source: "hook", reason: "off the allowlist" }])).toMatchObject({
      status: "denied",
    });
    const captcha = fake.captcha("topcv.vn");
    expect(captcha.status === "ok" && captcha.output).toMatchObject({ blocked: { reason: "captcha", site: "topcv.vn" } });
    const question = fake.applyPaused({ questions: [{ field: "notice", label: "Notice period", required: true, kind: "text", options: null }] });
    expect(question.status === "ok" && parseBotOutput("ApplyOutput", question.output).success).toBe(true);
    const login = fake.applyPaused({ reason: "needs_login", site: "itviec.com" });
    expect(login.status === "ok" && login.output).toMatchObject({ status: "paused", pauseReason: { reason: "needs_login", site: "itviec.com" } });
    const domain = fake.applyDomainConfirm("novapay.breezy.hr");
    expect(domain).toMatchObject({ status: "denied", output: { status: "paused", pauseReason: { reason: "domain_confirm", site: "novapay.breezy.hr" } } });
    expect(domain.status === "denied" && domain.denials[0]).toMatchObject({ source: "hook" });
  });

  it("emits started and the scripted events, waits on the clock, and honours cancellation", async () => {
    const clock = new FakeClock(new Date("2026-10-10T08:00:00.000Z"));
    const runner = new FakeRunner({ clock });
    const usage: RunnerEvent = { type: "usage", engine: "claude", usage: { fiveHour: 0.97, sevenDay: 0.4, resetsAt: null }, limited: false };
    runner.script({ bot: "cv", kind: "tailor", delayMs: 1000, events: [{ type: "progress", text: "cloning frame" }, usage], result: fake.failed("late") });
    const seen: RunnerEvent[] = [];
    let settled = false;
    const p = runner.run(task("cv", "tailor"), (e) => seen.push(e)).then((r) => {
      settled = true;
      return r;
    });
    await Promise.resolve();
    expect(seen.map((e) => e.type)).toEqual(["started", "progress", "usage"]);
    expect(runner.running).toBe(1);
    expect(settled).toBe(false);
    clock.advance(1000);
    expect((await p).status).toBe("failed");
    expect(runner.running).toBe(0);

    const controller = new AbortController();
    const q = runner.run(task("cv", "tailor", {}, { signal: controller.signal }), () => undefined);
    controller.abort();
    expect((await q).status).toBe("cancelled");
  });

  it("tracks concurrency per task key (lock and cap tests)", async () => {
    const clock = new FakeClock(new Date("2026-10-10T08:00:00.000Z"));
    const runner = new FakeRunner({ clock });
    runner.script({ bot: "research", kind: "fit", delayMs: 10, result: fake.failed("x") });
    const all = Promise.all([runner.run(task("research", "fit"), () => undefined), runner.run(task("research", "fit"), () => undefined)]);
    await Promise.resolve();
    expect(runner.maxConcurrent("research.fit")).toBe(2);
    clock.advance(10);
    await all;
    expect(runner.maxConcurrent()).toBe(2);
  });
});

describe("FakeClock", () => {
  it("fires timers in time order as it advances, including timers set by timers", () => {
    const clock = new FakeClock(new Date("2026-10-10T08:00:00.000Z"));
    const fired: string[] = [];
    clock.setTimer(200, () => fired.push(`b@${clock.now().toISOString()}`));
    clock.setTimer(100, () => {
      fired.push(`a@${clock.now().toISOString()}`);
      clock.setTimer(50, () => fired.push(`c@${clock.now().toISOString()}`));
    });
    const cancelled = clock.setTimer(120, () => fired.push("never"));
    clock.clearTimer(cancelled);
    clock.advance(300);
    expect(fired).toEqual(["a@2026-10-10T08:00:00.100Z", "c@2026-10-10T08:00:00.150Z", "b@2026-10-10T08:00:00.200Z"]);
    expect(clock.now().toISOString()).toBe("2026-10-10T08:00:00.300Z");
    expect(clock.pendingTimers()).toBe(0);
  });
});
