// Seam test (QA Phase 2): the engine (W2a) drives the REAL ClaudeRunner / CodexRunner (W2b) with
// W2c's real guard-hook builders, the real bots/<name>/bot.json + ROLE.md files and a real data
// folder. Only the outside world is fake: the CLI processes (fake spawn that answers with a valid
// output for the task), Chrome, Figma and the file store. Every task kind the engine produces must
// pass the runner's checks (no refusal), get exactly the flags its task needs, and the approval
// token must appear in no argv, prompt, file or transcript.
import { spawn as spawnProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONVERSATION_TASK_KINDS,
  findForbiddenPromptKeys,
  promptInputSchemaFor,
  type Engine as EngineName,
} from "@bs-job-agents/shared";
import { researchScanFixture } from "@bs-job-agents/shared/fixtures";
import type { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSearchProfile, createTask, createUpload, getApplicationByJob, getJob, latestApprovalForApplication, listTasks, openTestDb } from "../db/index.js";
import { seedBots, T0 } from "../db/test-helpers.js";
import { argValue, fakeSpawn, type FakeScript } from "../runner/__fixtures__/fake-cli.js";
import { ClaudeRunner, CodexRunner, defaultBotsDir, resolveRunnerConfig, type RunnerConfig } from "../runner/index.js";
import type { Runner, RunnerResult, RunnerTask } from "../runner/types.js";
import { EnginePaths } from "./config.js";
import { Engine } from "./engine.js";
import { FakeClock } from "./testing/fake-clock.js";
import { defaultFakeResult } from "./testing/fake-runner.js";
import { FakeBrowserProbe, FakeFigmaPort, FakeMasterCv, FakePdfText, MemoryFileStore, staticWorkflowSource } from "./testing/fakes.js";
import { botRegistryFrom, bridgeGuardHooks } from "./wiring.js";

const BOTS_DIR = defaultBotsDir();
const NOVAPAY = researchScanFixture.jobs[0]!;

interface Spawned {
  command: string;
  args: string[];
  /** Files the runner wrote for the CLI, read at spawn time (mcp.json, the Codex schema). */
  files: Record<string, string>;
}

interface Recorded {
  task: RunnerTask;
  key: string;
  spawns: Spawned[];
  result: RunnerResult;
  transcript: string;
}

/** stream-json of a successful `claude -p` run (shape of the real capture claude/structured-ok.jsonl). */
function claudeAnswer(output: unknown, sessionId: string, cwd: string): FakeScript {
  return {
    stdout: [
      { type: "system", subtype: "init", cwd, session_id: sessionId, tools: ["StructuredOutput"], mcp_servers: [], model: "claude-haiku-5-5", permissionMode: "default", apiKeySource: "none" },
      { type: "result", subtype: "success", is_error: false, num_turns: 1, duration_ms: 5, result: "", session_id: sessionId, structured_output: output },
    ].map((e) => JSON.stringify(e)),
    exitCode: 0,
  };
}

/** `codex exec --json` of a successful run plus its `-o` file (shape of codex/structured-ok.jsonl). */
function codexAnswer(output: unknown, threadId: string): FakeScript {
  const text = JSON.stringify(output);
  return {
    stdout: [
      { type: "thread.started", thread_id: threadId },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text } },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 10 } },
    ].map((e) => JSON.stringify(e)),
    stderr: ["Reading additional input from stdin..."],
    exitCode: 0,
    writeFiles: (args) => {
      const out = argValue(args, "-o");
      return out ? { [out]: text } : {};
    },
  };
}

function filesOf(args: readonly string[]): Record<string, string> {
  const files: Record<string, string> = {};
  for (const flag of ["--mcp-config", "--output-schema"]) {
    const path = argValue(args, flag);
    if (path && existsSync(path)) files[path] = readFileSync(path, "utf8");
  }
  return files;
}

/** A Runner that runs each task through a fresh real runner whose fake CLI answers for that task. */
function throughRealRunner(engine: EngineName, config: RunnerConfig, log: Recorded[]): Runner {
  return {
    engine,
    async run(task, onEvent) {
      // The FakeRunner's default output for the task; its selfCheck has the real bot.json's items.
      const answer = defaultFakeResult(task);
      if (answer.status !== "ok") throw new Error(`no default output for ${task.bot.name}.${task.kind}`);
      const output = answer.output;
      const sessionId = randomUUID();
      const spawns: Spawned[] = [];
      const fake = fakeSpawn((command, args) => {
        if (args[0] === "delete") return { exitCode: 0 };
        spawns.push({ command, args: [...args], files: filesOf(args) });
        return engine === "claude" ? claudeAnswer(output, sessionId, task.cwd) : codexAnswer(output, sessionId);
      });
      const runner =
        engine === "claude"
          ? new ClaudeRunner(config, { spawn: fake.spawn, randomUUID: () => sessionId })
          : new CodexRunner(config, { spawn: fake.spawn, codexPluginsToDisable: () => ["browser@openai-bundled"], codexMcpServersToDisable: () => ["node_repl"] });
      const result = await runner.run(task, onEvent);
      const transcript = existsSync(task.transcriptPath) ? readFileSync(task.transcriptPath, "utf8") : "";
      log.push({ task, key: `${task.bot.name}.${task.kind}`, spawns, result, transcript });
      return result;
    },
  };
}

/** Run a hook command line the way Claude Code does (through /bin/sh, the PreToolUse JSON on stdin). */
function runHook(command: string, input: unknown): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess("/bin/sh", ["-c", command], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

let root: string;
let dataDir: string;
let log: Recorded[];
let tokens: string[];
let engine: Engine;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "bsja-seam-"));
  dataDir = join(root, "data");
  log = [];
  const config = resolveRunnerConfig(
    {
      claudeBin: "/fake/claude",
      codexBin: "/fake/codex",
      tmpRoot: root,
      claudeConfigDir: join(root, "claude-config"),
      codexUserConfigPath: join(root, "codex-config.toml"),
      // W3a adds the orchestrator MCP server; Lead needs it.
      mcpServers: { orchestrator: { url: "http://127.0.0.1:4100/mcp" } },
    },
    { HOME: root, PATH: "/usr/bin:/bin" },
  );
  const db = openTestDb();
  seedBots(db);
  const clock = new FakeClock(T0);
  createSearchProfile(db, { roles: ["Frontend Engineer"], locations: ["Ho Chi Minh City"], sources: ["itviec", "topcv"] }, { now: clock.now() });
  const files = new MemoryFileStore();
  engine = new Engine({
    db,
    runners: { claude: throughRealRunner("claude", config, log), codex: throughRealRunner("codex", config, log) },
    bots: botRegistryFrom(BOTS_DIR),
    workflows: staticWorkflowSource(),
    paths: new EnginePaths(dataDir, BOTS_DIR),
    files,
    browser: new FakeBrowserProbe(),
    figma: new FakeFigmaPort(files),
    guards: bridgeGuardHooks,
    pdf: new FakePdfText(),
    masterCv: new FakeMasterCv(join(dataDir, "master-cv.yaml"), files),
    clock,
  });
  await engine.start();

  // §7.2 job-scan over two sources (a VI JD gets VI and EN CVs), then UC-08 approve → Apply.
  const scan = engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
  await engine.idle();
  const jobId = [1, 2].find((id) => getJob(db, id)?.title === NOVAPAY.title)!;
  const card = engine.replay().map((e) => e.event).find((e) => e.type === "review.ready" && e.jobId === String(jobId));
  expect(card, "the NovaPay review card").toBeDefined();
  const cvVersionId = Number((card as { cvVersionIds: string[] }).cvVersionIds[0]);
  const approved = engine.approve(jobId, { cvVersionId, introText: "Hello NovaPay" });
  expect(approved.applicationId).not.toBeNull();
  await engine.idle();
  expect(scan.id).toBe(1);

  // §7.3 apply-to-link and §7.3b apply-to-file (Research single / file).
  engine.startWorkflow({ workflow: "apply-to-link", params: { url: "https://itviec.com/it-jobs/frontend-9", applyAgain: false, searchProfileId: null } }, { trigger: "link" });
  files.write(join(dataDir, "uploads/7-JD (final), NovaPay.pdf"), "%PDF a JD");
  const upload = createUpload(db, { filename: "JD (final), NovaPay.pdf", mime: "application/pdf", size: 9, path: "uploads/7-JD (final), NovaPay.pdf", sha256: "f".repeat(64) });
  engine.startWorkflow({ workflow: "apply-to-file", params: { uploadId: String(upload.id), searchProfileId: null } }, { trigger: "chat" });
  await engine.idle();

  // The chat tasks W3a will queue: Lead's chat, a consult thread with every bot (UC-25), room replies (UC-15).
  const conversation = { roomId: "3", messageId: "9", text: "How should I present the AI lab work?", history: [{ author: "ba", text: "Hi" }], uploadIds: [] };
  const tasks: Array<{ bot: string; kind: string; engine: EngineName; input: unknown }> = [
    { bot: "lead", kind: "chat", engine: "claude", input: { ...conversation, text: "Find frontend jobs in HCM" } },
    ...(["lead", "research", "cv", "qa", "apply"] as const).map((bot) => ({
      bot,
      kind: "consult",
      engine: (bot === "research" || bot === "qa" ? "codex" : "claude") as EngineName,
      input: conversation,
    })),
    { bot: "cv", kind: "discussion", engine: "claude", input: conversation },
    { bot: "qa", kind: "discussion", engine: "codex", input: conversation },
  ];
  for (const t of tasks) createTask(db, { runId: null, stepId: null, botName: t.bot, kind: t.kind, engine: t.engine, input: t.input, promptVersion: 1 }, { now: clock.now() });
  engine.dispatch();
  await engine.idle();

  tokens = [jobId]
    .map((id) => getApplicationByJob(db, id)!)
    .map((app) => latestApprovalForApplication(db, app.id)!.token);
  expect(listTasks(db).filter((t) => t.status !== "done").map((t) => `${t.botName}.${t.kind}: ${t.status} ${t.error ?? ""}`)).toEqual([]);
}, 60_000);

afterAll(() => {
  engine?.stop();
  rmSync(root, { recursive: true, force: true });
});

const only = (key: string) => log.filter((r) => r.key === key);
const first = (key: string) => only(key)[0]!;
const spawned = (key: string) => first(key).spawns[0]!;
const prompt = (r: Recorded) => (r.task.bot.engine === "claude" ? r.spawns[0]!.args[1]! : r.spawns[0]!.args.at(-1)!);
const settingsOf = (args: readonly string[]) =>
  JSON.parse(argValue(args, "--settings")!) as { autoMemoryEnabled: boolean; hooks?: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> } };

describe("every task kind the engine produces runs through the real runners", () => {
  it("covers every Phase 1 task kind plus Lead's chat, consult and discussion, and none is refused", () => {
    const keys = [...new Set(log.map((r) => r.key))].sort();
    expect(keys).toEqual(
      [
        "apply.consult",
        "apply.submit",
        "cv.consult",
        "cv.discussion",
        "cv.tailor",
        "lead.chat",
        "lead.consult",
        "qa.consult",
        "qa.discussion",
        "qa.review",
        "research.company",
        "research.consult",
        "research.file",
        "research.fit",
        "research.scan",
        "research.single",
      ].sort(),
    );
    for (const r of log) expect(r.result.status, `${r.key} #${r.task.taskId}: ${JSON.stringify(r.result)}`).toBe("ok");
    // One CLI call each: valid output on the first try, no repair.
    for (const r of log) expect(r.spawns, r.key).toHaveLength(1);
  });

  it("every input fits its prompt schema exactly (no unknown key slips into a prompt) and carries no guard-only key", () => {
    for (const r of log) {
      const where = `${r.key} #${r.task.taskId}`;
      expect(findForbiddenPromptKeys(r.task.input), where).toEqual([]);
      const schema = promptInputSchemaFor(r.task.bot.name, r.task.kind) as z.AnyZodObject | null;
      if (!schema) {
        expect(r.key, "only Lead's chat has no prompt schema yet (W3a)").toBe("lead.chat");
        continue;
      }
      const parsed = schema.safeParse(r.task.input);
      expect(parsed.success, `${where}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
      const unknown = Object.keys(r.task.input as object).filter((k) => !Object.hasOwn(schema.shape, k));
      expect(unknown, where).toEqual([]);
    }
  });

  it("transcripts, sessions and work dirs: data/transcripts/<task>-<attempt>.jsonl, nothing left behind", () => {
    for (const r of log) {
      expect(r.task.transcriptPath).toBe(join(dataDir, "transcripts", `${r.task.taskId}-${r.task.attempt}.jsonl`));
      expect(r.transcript, r.key).toContain('"type":"runner.result","status":"ok"');
    }
    // The runners' per-task work dirs (mcp.json, schema.json, last.json) in tmpRoot are all removed.
    expect(readdirSync(root).filter((n) => n.startsWith("bsja-"))).toEqual([]);
  });
});

describe("flags per task (§4.4, §5.5, spike S1/S2/S4)", () => {
  it("research.scan (Codex, holds the browser lock): Ba's config with only Chrome, live search, sites in the prompt", () => {
    const { args } = spawned("research.scan");
    expect(args).not.toContain("--ignore-user-config");
    expect(args).toContain('plugins."browser@openai-bundled".enabled=false');
    expect(args).toContain("skip_host_skill_discovery");
    expect(args).toContain('web_search="live"');
    expect(argValue(args, "--sandbox")).toBe("read-only");
    expect(prompt(first("research.scan"))).toContain("open only these sites: topcv.vn, itviec.com, linkedin.com");
    expect(JSON.parse(spawned("research.scan").files[argValue(args, "--output-schema")!]!).title).toBe("ResearchScanOutput");
  });

  it("research.single holds the browser lock too; fit, company and file are search-only (no Chrome)", () => {
    expect(spawned("research.single").args).toContain("skip_host_skill_discovery");
    for (const key of ["research.fit", "research.company", "research.file"]) {
      const { args } = spawned(key);
      expect(args.slice(0, 6), key).toEqual(["exec", "--json", "--skip-git-repo-check", "--ignore-user-config", "--disable", "apps"]);
      expect(args, key).toContain('web_search="live"');
      expect(prompt(first(key)), key).not.toContain("open only these sites");
    }
  });

  it("Research and QA read only their own task folder: master-cv.yaml (fit, review) or Ba's upload (file)", () => {
    for (const key of ["research.fit", "qa.review", "research.file"]) {
      const r = first(key);
      const taskDir = join(dataDir, "tasks", String(r.task.taskId));
      expect(r.task.readDirs, key).toEqual([taskDir]);
      expect(prompt(r), key).toContain(`you may read only: ${taskDir}.`);
    }
    // PM2 M4: the copy's name is the orchestrator's; Ba's file name stays out of the trusted path.
    const file = first("research.file");
    expect(file.task.input).toMatchObject({ filename: "JD (final), NovaPay.pdf", path: join(dataDir, "tasks", String(file.task.taskId), `upload-${(file.task.input as { uploadId: string }).uploadId}.pdf`) });
    expect(first("research.company").task.readDirs).toBeUndefined();
    expect(spawned("qa.review").args).toContain('web_search="disabled"');
  });

  it("cv.tailor (Claude): Read on its task folder, the Figma tools, and the Figma guard merged into --settings", () => {
    const r = first("cv.tailor");
    const taskDir = join(dataDir, "tasks", String(r.task.taskId));
    const { args, files } = spawned("cv.tailor");
    expect(argValue(args, "--tools")).toBe("Read");
    expect(args).toContain(`Read(/${taskDir}/**)`);
    expect(args).toContain("mcp__figma__figma_execute");
    expect(argValue(args, "--add-dir")).toBe(taskDir);
    expect(args).not.toContain("--chrome");
    expect(JSON.parse(files[argValue(args, "--mcp-config")!]!)).toMatchObject({ mcpServers: { figma: { type: "stdio" } } });
    const hooks = settingsOf(args).hooks!.PreToolUse;
    expect(hooks.map((h) => h.matcher)).toEqual(["mcp__figma__.*"]);
    // The guard's config sits outside the bot's read folder (which holds master-cv.yaml only).
    const guardConfig = join(dataDir, "guards", String(r.task.taskId), "figma-guard.json");
    expect(hooks[0]!.hooks[0]!.command).toContain(`'--config' '${guardConfig}'`);
    expect(existsSync(guardConfig)).toBe(true);
    expect(existsSync(join(taskDir, "figma-guard.json"))).toBe(false);
    // The templates from the "before" fingerprint reach the bot (coordinator B).
    expect(r.task.input).toMatchObject({ templates: [expect.objectContaining({ id: "459:1767" })] });
  });

  it("apply.submit (Claude): Chrome with the write tools, its application folder only, the site guard merged", () => {
    const r = first("apply.submit");
    const appDir = join(dataDir, "applications", String((r.task.input as { applicationId: string }).applicationId));
    const { args, files } = spawned("apply.submit");
    expect(args).toContain("--chrome");
    expect(argValue(args, "--add-dir")).toBe(appDir);
    expect(r.task.readDirs).toEqual([appDir]);
    expect(args).toContain(`Read(/${appDir}/**)`);
    const allowed = args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--disallowedTools"));
    expect(allowed).toContain("mcp__claude-in-chrome__file_upload");
    // §4.4: Apply runs without javascript_tool (hidden from the model, never allowed).
    expect(allowed).not.toContain("mcp__claude-in-chrome__javascript_tool");
    expect(args.slice(args.indexOf("--disallowedTools"))).toContain("mcp__claude-in-chrome__javascript_tool");
    expect(args).not.toContain("--mcp-config");
    expect(files).toEqual({});
    const hooks = settingsOf(args).hooks!.PreToolUse;
    expect(hooks.map((h) => h.matcher)).toContain("mcp__claude-in-chrome__navigate");
    expect(hooks[0]!.hooks[0]!.command).toContain("'--allow' 'itviec.com'");
    expect(hooks[0]!.hooks[0]!.command).toContain(`'--log' '${join(dataDir, "transcripts", `${r.task.taskId}-1.guard.jsonl`)}'`);
    // The recruiter-facing copy (PM FYI d) in the application folder.
    expect(r.task.input).toMatchObject({ pdfPath: join(appDir, "BA_HUYNH_NOVAPAY_EN.pdf") });
    expect(prompt(r)).toContain("open only these sites: itviec.com");
  });

  it("lead.chat: only the orchestrator's MCP tools (rule 5); no file, browser or shell tools", () => {
    const { args, files } = spawned("lead.chat");
    expect(argValue(args, "--tools")).toBe("");
    const allowed = args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--mcp-config"));
    expect(allowed.every((t) => t.startsWith("mcp__orchestrator__"))).toBe(true);
    expect(args).not.toContain("--chrome");
    expect(args).not.toContain("--add-dir");
    expect(JSON.parse(files[argValue(args, "--mcp-config")!]!)).toEqual({ mcpServers: { orchestrator: { type: "http", url: "http://127.0.0.1:4100/mcp" } } });
    expect(settingsOf(args)).toEqual({ autoMemoryEnabled: false });
  });

  it("consult and discussion run read-only: no browser, no MCP server, no web search, no hooks (UC-15, UC-25)", () => {
    for (const r of log.filter((x) => (CONVERSATION_TASK_KINDS as readonly string[]).includes(x.task.kind))) {
      const args = r.spawns[0]!.args;
      expect(args, r.key).not.toContain("--chrome");
      expect(args, r.key).not.toContain("--mcp-config");
      expect(args.join(" "), r.key).not.toContain("mcp_servers.");
      if (r.task.bot.engine === "claude") expect(settingsOf(args), r.key).toEqual({ autoMemoryEnabled: false });
      else expect(args, r.key).toContain('web_search="disabled"');
      expect(r.task.hookSettings, r.key).toBeUndefined();
    }
  });
});

describe("the approval token never reaches a model (PM S5)", () => {
  it("is in no RunnerTask, argv, prompt, CLI file or transcript", () => {
    expect(tokens.length).toBeGreaterThan(0);
    for (const r of log) {
      const everything = [JSON.stringify(r.task), ...r.spawns.flatMap((s) => [...s.args, ...Object.values(s.files)]), r.transcript].join("\n");
      for (const token of tokens) expect(everything.includes(token), r.key).toBe(false);
      expect(everything.includes("approvalToken"), r.key).toBe(false);
    }
  });
});

describe("the merged hook commands work as Claude Code runs them (W2c hooks, source mode via tsx)", () => {
  it("the site guard in Apply's --settings allows the approved domain and blocks any other", async () => {
    const r = first("apply.submit");
    const hook = settingsOf(spawned("apply.submit").args).hooks!.PreToolUse.find((h) => h.matcher === "mcp__claude-in-chrome__navigate")!;
    const navigate = (url: string) => ({ hook_event_name: "PreToolUse", tool_name: "mcp__claude-in-chrome__navigate", tool_input: { url } });
    expect((await runHook(hook.hooks[0]!.command, navigate("https://itviec.com/it-jobs/frontend-1"))).code).toBe(0);
    const blocked = await runHook(hook.hooks[0]!.command, navigate("https://mail.google.com/"));
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toMatch(/Blocked by site guard/);
    // Each decision is in the guard log the engine reads after the task (coordinator E).
    const guardLog = readFileSync(join(dataDir, "transcripts", `${r.task.taskId}-1.guard.jsonl`), "utf8");
    expect(guardLog.trim().split("\n").map((l) => (JSON.parse(l) as { decision: string }).decision)).toEqual(["allow", "block"]);
  }, 60_000);

  it("the Figma guard in CV's --settings blocks code that reaches outside the Drafts page", async () => {
    const hook = settingsOf(spawned("cv.tailor").args).hooks!.PreToolUse[0]!;
    const execute = (code: string) => ({ hook_event_name: "PreToolUse", tool_name: "mcp__figma__figma_execute", tool_input: { code } });
    const blocked = await runHook(hook.hooks[0]!.command, execute("const p = figma.root.children.find((x) => x.name === 'resume'); p.remove();"));
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toMatch(/Figma guard/);
  }, 60_000);
});
