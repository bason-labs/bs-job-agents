// Contract tests with the other Phase 2 workers' code: W2b's real bot.json files and runner
// checks accept every RunnerTask the engine builds, and the production adapters work on W2c's
// bridges (fakes only for the outside world: no real CLI, Chrome or Figma).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainSchema, findForbiddenPromptKeys, promptInputSchemaFor } from "@bs-job-agents/shared";
import { afterEach, describe, expect, it } from "vitest";
import { FakeFigmaMcp, writePdf } from "../bridges/testing.js";
import { FigmaBridge, buildFingerprint } from "../bridges/index.js";
import { listMemoryChanges, openTestDb } from "../db/index.js";
import { seedBots, seedRun, seedTask } from "../db/test-helpers.js";
import { assertRunnableBot, defaultBotsDir } from "../runner/index.js";
import type { FigmaPort } from "./ports.js";
import { createTestEngine } from "./testing/harness.js";
import { botRegistryFrom, bridgeGuardHooks, fileMasterCv, memoryWriter, pdfTextExtractor } from "./wiring.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});
const temp = () => (dir = mkdtempSync(join(tmpdir(), "bsja-wiring-")));

describe("contract with W2b's runner (src/runner, bots/*.json)", () => {
  it("every RunnerTask of a full job-scan → apply passes the runner's own checks, with the real bot definitions", async () => {
    const bots = botRegistryFrom(defaultBotsDir()).list();
    expect(bots.map((b) => b.name).sort()).toEqual(["apply", "cv", "lead", "qa", "research"]);
    const t = await createTestEngine({ sources: ["itviec", "topcv"], bots });
    const run = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    const card = t.review(run.id, 1)!;
    t.engine.approve(1, { cvVersionId: card.cvVersions[0]!.cvVersionId, introText: "Hello" });
    await t.idle();
    const keys = new Set(t.runner.calls.map((c) => `${c.bot.name}.${c.kind}`));
    expect([...keys].sort()).toEqual(["apply.submit", "cv.tailor", "qa.review", "research.company", "research.fit", "research.scan"]);
    for (const task of t.runner.calls) {
      const where = `${task.bot.name}.${task.kind} #${task.taskId}`;
      expect(() => assertRunnableBot(task.bot), where).not.toThrow();
      expect(findForbiddenPromptKeys(task.input), where).toEqual([]);
      const schema = promptInputSchemaFor(task.bot.name, task.kind);
      const parsed = schema?.safeParse(task.input);
      expect(parsed?.success, `${where}: ${JSON.stringify(parsed?.error?.issues)}`).toBe(true);
      for (const d of task.readDirs ?? []) expect(d, where).toMatch(/^\/[^\s,()]*$/);
      for (const s of task.allowedSites ?? []) expect(DomainSchema.safeParse(s).success, where).toBe(true);
      expect(task.cwd).toBe(`/bots/${task.bot.name}`);
      expect(task.transcriptPath).toBe(`/data/transcripts/${task.taskId}-${task.attempt}.jsonl`);
    }
  });
});

describe("production adapters on W2c's bridges", () => {
  it("W2c's FigmaBridge class is the engine's FigmaPort", async () => {
    const port: FigmaPort = new FigmaBridge({ connect: async () => new FakeFigmaMcp({ connected: false }) });
    expect(await port.status()).toMatchObject({ connected: false, message: expect.stringMatching(/Figma/) });
  });

  it("guard hooks: the site guard for the task's sites, the Figma guard config in the task folder", async () => {
    const d = temp();
    const site = bridgeGuardHooks.siteGuard({ allowedSites: ["itviec.com", "novapay.breezy.hr"], logFile: join(d, "g.jsonl") });
    const commands = site.hooks.PreToolUse.map((m) => m.matcher);
    expect(commands).toContain("mcp__claude-in-chrome__navigate");
    expect(site.hooks.PreToolUse[0]!.hooks[0]!.command).toMatch(/'--allow' 'itviec\.com' '--allow' 'novapay\.breezy\.hr' '--log' /);
    const fingerprint = buildFingerprint({ fileKey: "kJFoXNrTfFOtkQ515c0jHk", draftsPageName: "Drafts", pages: [{ id: "1:1", name: "resume", nodes: [] }], resources: null, takenAt: "2026-10-10T08:00:00.000Z" });
    const figma = await bridgeGuardHooks.figmaGuard({ fingerprint, dir: d, logFile: join(d, "g.jsonl"), draftsPageId: "900:1" });
    expect(figma.hooks.PreToolUse.map((m) => m.matcher)).toEqual(["mcp__figma__.*"]);
    expect(JSON.parse(readFileSync(join(d, "figma-guard.json"), "utf8"))).toMatchObject({ policy: { draftsPageId: "900:1", protectedPageIds: ["1:1"] } });
  });

  it("PDF text, the master CV version and memory notes", async () => {
    const d = temp();
    await writePdf(join(d, "cv.pdf"), [{ runs: [{ text: "Ba Huynh", x: 40, y: 800 }, { text: "Software Engineer", x: 40, y: 780 }] }]);
    expect(await pdfTextExtractor.extractText(join(d, "cv.pdf"))).toMatch(/Ba Huynh\s+Software Engineer/);

    expect(fileMasterCv(join(d, "missing.yaml")).version()).toBeNull();
    writeFileSync(join(d, "master-cv.yaml"), "version: 4\ncontact:\n  name: Ba Huynh\n");
    expect(fileMasterCv(join(d, "master-cv.yaml")).version()).toBe(4);

    const db = openTestDb();
    seedBots(db);
    const ctx = seedRun(db);
    const task = seedTask(db, ctx);
    mkdirSync(join(d, "research"));
    // PM2 S5: memory.md is gitignored; start-up seeds it from the (empty) template.
    await memoryWriter(db, d).seed!(["research"]);
    expect(readFileSync(join(d, "research", "memory.md"), "utf8")).toBe("");
    await memoryWriter(db, d).append({ botName: "research", notes: ["TopCV upload limit is 5MB"], runId: ctx.run.id, taskId: task.id });
    expect(readFileSync(join(d, "research", "memory.md"), "utf8")).toMatch(/TopCV upload limit is 5MB/);
    expect(listMemoryChanges(db, "research").map((m) => [m.note, m.taskId])).toEqual([["TopCV upload limit is 5MB", task.id]]);
  });
});
