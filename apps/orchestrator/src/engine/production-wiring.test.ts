// Smoke test (QA Phase 2, seam d): the production engine as Phase 3 builds it — createProductionEngine
// + createRunners + the wiring.ts adapters (botRegistryFrom, bridgeGuardHooks, nodeFileStore,
// pdfTextExtractor, fileMasterCv, memoryWriter) + W2c's FigmaBridge as the FigmaPort — constructs
// and runs a job-scan from the trigger to the frozen §9.1 record on a real data folder. Only the
// outside world is fake: the claude / codex processes (a fake spawn that answers like the CLIs),
// the figma-console-mcp connection (FakeFigmaMcp running the bridge's plugin code on a FakeFigmaApi
// document) and Chrome (a probe override). No real CLI, Chrome or Figma is touched.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBotOutputJsonSchema } from "@bs-job-agents/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FigmaBridge } from "../bridges/index.js";
import { FakeFigmaApi, FakeFigmaMcp, FakeNode, FIGMA_A4, makePdf } from "../bridges/testing.js";
import { sha256File } from "../bridges/pdf/hash.js";
import {
  createSearchProfile,
  getApplicationByJob,
  getCvVersion,
  getPromptVersion,
  getRun,
  getSubmissionRecord,
  listBots,
  listMemoryChanges,
  listTasks,
  openTestDb,
  type Db,
} from "../db/index.js";
import { argValue, fakeSpawn, type FakeScript, type SpawnCall } from "../runner/__fixtures__/fake-cli.js";
import { createRunners, defaultBotsDir, loadBotDefinition } from "../runner/index.js";
import type { RunnerTask } from "../runner/types.js";
import type { Engine } from "./engine.js";
import { defaultFakeResult } from "./testing/fake-runner.js";
import { FakeBrowserProbe, staticWorkflowSource } from "./testing/fakes.js";
import { createProductionEngine } from "./wiring.js";
import { createScanOutputChecker } from "../adapters/index.js";

const CLAUDE = "/fake/bin/claude";
const CODEX = "/fake/bin/codex";

/** The task the prompt describes: its `# Task: bot.kind` line and its input, untrusted blocks put back. */
function taskFromPrompt(prompt: string): { bot: string; kind: string; input: Record<string, unknown> } {
  const [, bot = "", kind = ""] = /^# Task: ([a-z]+)\.([a-z]+)$/m.exec(prompt) ?? [];
  const json = /Task input \(JSON\):\n\n```json\n([\s\S]*?)\n```/.exec(prompt)?.[1] ?? "{}";
  const input = JSON.parse(json) as Record<string, unknown>;
  for (const m of prompt.matchAll(/<<<UNTRUSTED_CONTENT id="([0-9a-f]+)" field="([A-Za-z]+)">>>\n([\s\S]*?)\n<<<END_UNTRUSTED_CONTENT id="\1">>>/g)) {
    const [, , field = "", content = ""] = m;
    try {
      input[field] = JSON.parse(content) as unknown;
    } catch {
      input[field] = content;
    }
  }
  return { bot, kind, input };
}

let root: string;
let dataDir: string;
let botsDir: string;
let db: Db;
let engine: Engine;
let api: FakeFigmaApi;
let mcp: FakeFigmaMcp;
let calls: SpawnCall[];
let runId: number;
let cvPdf: Uint8Array;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "bsja-prod-"));
  dataDir = join(root, "data");
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, "master-cv.yaml"), "version: 3\ncontact:\n  name: Ba Huynh\nfacts: []\n");
  // A copy of bots/: memory notes are appended to bots/<name>/memory.md (rule 2).
  botsDir = join(root, "bots");
  cpSync(defaultBotsDir(), botsDir, { recursive: true });
  cvPdf = await makePdf([{ size: FIGMA_A4, runs: [{ text: "BA HUYNH", x: 40, y: 800 }, { text: "Software Engineer", x: 40, y: 780 }] }]);

  api = new FakeFigmaApi({
    pages: [
      {
        id: "0:1",
        name: "resume",
        children: [{ id: "459:1767", name: "BA HUYNH — Software Engineer Resume | Refreshed", width: 595, height: 842, pdf: cvPdf, children: [{ id: "459:1800", name: "Professional title", characters: "Software Engineer" }] }],
      },
      { id: "1:2", name: "components", children: [{ id: "20:1", type: "COMPONENT", name: "Chip" }] },
    ],
  });
  mcp = new FakeFigmaMcp({ api });

  // The CLIs: answer each task with a valid output (its self-check items from the real bot.json).
  const spawn = fakeSpawn((command, args): FakeScript => {
    if (command === CODEX && args[0] === "delete") return { exitCode: 0 };
    const prompt = command === CLAUDE ? args[1]! : args.at(-1)!;
    const { bot, kind, input } = taskFromPrompt(prompt);
    const def = loadBotDefinition(join(botsDir, bot));
    const answer = defaultFakeResult({ bot: def, kind, input } as unknown as RunnerTask);
    if (answer.status !== "ok") throw new Error(`no answer for ${bot}.${kind}`);
    const output = answer.output;
    if (bot === "cv" && kind === "tailor") {
      // What the CV bot does through figma_execute: its frame on the Drafts page.
      const frameName = String((output as { figmaFrameName?: unknown }).figmaFrameName);
      api.page("Drafts").appendChild(new FakeNode(api, { name: frameName, width: 595, height: 842, pdf: cvPdf }));
    }
    if (command === CLAUDE) {
      const sessionId = argValue(args, "--session-id")!;
      return {
        stdout: [
          { type: "system", subtype: "init", session_id: sessionId, tools: ["StructuredOutput"], mcp_servers: [], model: "claude-haiku-5-5" },
          { type: "result", subtype: "success", is_error: false, num_turns: 1, result: "", session_id: sessionId, structured_output: output },
        ].map((e) => JSON.stringify(e)),
        exitCode: 0,
      };
    }
    const text = JSON.stringify(output);
    return {
      stdout: [
        { type: "thread.started", thread_id: "01a126da-c068-79b0-93c3-7cf34d4305ec" },
        { type: "item.completed", item: { id: "item_0", type: "agent_message", text } },
        { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 10 } },
      ].map((e) => JSON.stringify(e)),
      exitCode: 0,
      writeFiles: (a) => ({ [argValue(a, "-o")!]: text }),
    };
  });
  calls = spawn.calls;

  // A fresh database as in production: no seedBots(); the engine's start-up fills the bots table.
  db = openTestDb();
  createSearchProfile(db, { roles: ["Frontend Engineer"], locations: ["Ho Chi Minh City"], sources: ["itviec"] });
  const runners = createRunners(
    {
      claudeBin: CLAUDE,
      codexBin: CODEX,
      tmpRoot: root,
      claudeConfigDir: join(root, "claude-config"),
      mcpServers: { orchestrator: { url: "http://127.0.0.1:4100/mcp" } },
    },
    { spawn: spawn.spawn, codexPluginsToDisable: () => [], codexMcpServersToDisable: () => [] },
  );
  engine = createProductionEngine({
    db,
    dataDir,
    botsDir,
    runners,
    workflows: staticWorkflowSource(),
    figma: new FigmaBridge({ connect: async () => mcp }),
    browser: new FakeBrowserProbe(),
    config: { bridgePollMs: 60_000, schedulerPollMs: 60_000 },
  });
  await engine.start();
  runId = engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" }).id;
  await engine.idle();
  const cvVersionId = Number((engine.replay().map((e) => e.event).find((e) => e.type === "review.ready") as { cvVersionIds: string[] }).cvVersionIds[0]);
  engine.approve(1, { cvVersionId, introText: null });
  await engine.idle();
}, 60_000);

afterAll(() => {
  engine?.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("the production engine on the real adapters (createProductionEngine)", () => {
  it("runs job-scan through Apply to its record with the real runners, bridges and file store", () => {
    expect(listTasks(db).map((t) => [`${t.botName}.${t.kind}`, t.status, t.error])).toEqual([
      ["research.scan", "done", null],
      ["research.fit", "done", null],
      ["research.company", "done", null],
      ["cv.tailor", "done", null],
      ["qa.review", "done", null],
      ["apply.submit", "done", null],
    ]);
    expect(getRun(db, runId)?.status).toBe("done");
    // Only the fake CLIs ran.
    expect([...new Set(calls.map((c) => c.command))].sort()).toEqual([CLAUDE, CODEX]);
  });

  it("PM3 S8: the scan-output checker comes from the source adapters (src/adapters) and accepted the scan", () => {
    expect(engine.deps.scanChecker).toBe(createScanOutputChecker());
  });

  it("the CV PDF is the FigmaBridge's export into data/pdf, hashed, its text read by pdf.js", async () => {
    const cv = getCvVersion(db, 1)!;
    expect(cv.pdfPath).toMatch(/^pdf\/.+_EN_v1\.pdf$/);
    expect(await sha256File(join(dataDir, cv.pdfPath!))).toBe(cv.pdfSha256);
    // The QA task got the extracted text of that file.
    const qa = listTasks(db).find((t) => t.kind === "review")!;
    expect((qa.input as { pdfText: string }).pdfText).toMatch(/BA HUYNH\s+Software Engineer/);
    // figma_execute calls ran the bridge's own plugin code: Drafts, fingerprints, frame lookup, export.
    const ops = mcp.executeCalls().map((c) => c.op);
    expect(ops).toEqual(expect.arrayContaining(["ensure-drafts", "fingerprint-page", "find-draft-frame", "export-pdf"]));
    expect(api.page("Drafts").children.map((n) => n.name)).toHaveLength(1);
  });

  it("Apply uploaded a verified copy from data/applications/<id>; the record holds the orchestrator's hash", async () => {
    const app = getApplicationByJob(db, 1)!;
    const cv = getCvVersion(db, app.cvVersionId!)!;
    const copy = join(dataDir, "applications", String(app.id), "BA_HUYNH_NOVAPAY_EN.pdf");
    expect(await sha256File(copy)).toBe(cv.pdfSha256);
    const record = getSubmissionRecord(db, app.id)!;
    // PM2 M1: no capture pipeline yet (S7), so the screenshots Apply names are not on disk: the
    // record cites none and a real Apply ends in needs_check, never clean (the intended fail-safe).
    expect(app).toMatchObject({ status: "needs_check", statusHistory: expect.arrayContaining([expect.objectContaining({ status: "needs_check", note: "screenshots not captured" })]) });
    expect(record.submission).toMatchObject({ preSubmitScreenshotPath: null, confirmationScreenshotPath: null });
    expect(record.submission).toMatchObject({ uploadedPath: `applications/${app.id}/BA_HUYNH_NOVAPAY_EN.pdf`, uploadedSha256: cv.pdfSha256 });
    // Research runs on Claude with Chrome too (E1 option A): pick Apply's spawn by its task.
    const apply = calls.find((c) => c.command === CLAUDE && c.args.includes("--chrome") && taskFromPrompt(c.args[1]!).bot === "apply")!;
    expect(argValue(apply.args, "--add-dir")).toBe(join(dataDir, "applications", String(app.id)));
  });

  it("guards, transcripts, the master CV copy, memory notes and the bots' schemas, all on disk", () => {
    const tasks = listTasks(db);
    for (const t of tasks) expect(existsSync(join(dataDir, "transcripts", `${t.id}-${t.attempt}.jsonl`)), `${t.botName}.${t.kind}`).toBe(true);
    const cvTask = tasks.find((t) => t.kind === "tailor")!;
    // The bot's read folder holds its copy of master-cv.yaml and nothing else (no guard config).
    expect(readdirSync(join(dataDir, "tasks", String(cvTask.id)))).toEqual(["master-cv.yaml"]);
    expect(readFileSync(join(dataDir, "tasks", String(cvTask.id), "master-cv.yaml"), "utf8")).toContain("version: 3");
    expect(JSON.parse(readFileSync(join(dataDir, "guards", String(cvTask.id), "figma-guard.json"), "utf8"))).toMatchObject({
      policy: { draftsPageName: "Drafts", protectedPageIds: ["0:1", "1:2"] },
    });
    // Rule 2: the scan's memory note went to the bot copy's memory.md and memory_changes.
    expect(readFileSync(join(botsDir, "research", "memory.md"), "utf8")).toMatch(/TopCV salary often hidden/);
    expect(listMemoryChanges(db, "research")).toHaveLength(1);
    // The runners removed their work dirs.
    expect(readdirSync(root).filter((n) => n.startsWith("bsja-"))).toEqual([]);
    expect(getBotOutputJsonSchema("CvOutput")).toBeDefined();
  });

  it("start-up filled the bots table from bot.json and stored each ROLE.md for its prompt version", () => {
    expect(listBots(db).map((b) => b.name)).toEqual(["apply", "cv", "lead", "qa", "research"]);
    for (const name of ["apply", "cv", "lead", "qa", "research"]) {
      expect(getPromptVersion(db, name, loadBotDefinition(join(botsDir, name)).promptVersion)?.roleMdText, name).toBe(readFileSync(join(botsDir, name, "ROLE.md"), "utf8"));
    }
  });

  it("no safety event and no needs_* wait on the way", () => {
    const types = engine.replay().map((e) => e.event.type);
    expect(types).not.toContain("safety.denied");
    expect(types).not.toContain("task.paused");
    expect(types.filter((t) => t === "run.finished")).toHaveLength(1);
  });
});
