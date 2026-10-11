// Live-shape e2e launcher (PM3 S9, §12 "Playwright + FakeRunner"). TEST ONLY: it lives outside
// src/, so `pnpm build` never puts it in dist/, and nothing in the app imports it.
//
// It starts the REAL orchestrator from the built dist/ (startOrchestrator: the API, SSE, the Lead
// MCP server, the production engine with W4a's scan checker, the chat sink) on a throwaway data
// folder, with these stand-ins only:
//   - FakeRunner for every bot (no claude/codex CLI is ever spawned). Lead's fake connects to the
//     orchestrator MCP server with its per-spawn capability, exactly as `claude -p` would, and calls
//     start_workflow there; so run cards come from the capability log, not from model text.
//   - a fake Figma port that writes a real one-page A4 PDF; a fake Chrome probe (connected).
// Ba's chat text picks what the fake Lead does (see leadReply): "scan" starts job-scan, "Đà Nẵng"
// proposes a criteria change (UC-21b), "every weekday" proposes a schedule (UC-21), "[usage-limit]"
// hits a usage limit once (UC-16).
//
// A small control server (E2E_CONTROL_PORT) lets the Playwright lane reset to a fresh data folder
// between tests and read what the fake runners were asked to do:
//   GET  /ready   200 once the orchestrator listens
//   POST /reset   stop it, start a fresh one on a new data folder (same port); 200 {dataDir}
//   GET  /calls   [{key, input}] of every runner task since the last reset
//
// Env: E2E_ORCH_PORT (default 4199), E2E_CONTROL_PORT (4198), ORCH_WEB_ORIGINS (the web app).
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { ApplyOutput, LeadOutput } from "@bs-job-agents/shared";
import type * as StartModule from "../src/api/boot/start.js";
import type * as ConfigModule from "../src/config.js";
import type * as TestingModule from "../src/engine/testing/index.js";
import type * as FakeRunnerModule from "../src/engine/testing/fake-runner.js";
import type { Runner, RunnerResult, RunnerTask } from "../src/runner/types.js";
import type { McpServerConfig } from "../src/runner/index.js";
import type * as McpModule from "../src/mcp/index.js";
import { fakeFormScreenshot } from "./png.js";
import { LIVE_SHAPE_CRITERIA, scanOutputFor } from "./scenario.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist");
const REPO = join(HERE, "..", "..", "..");

async function fromDist<T>(rel: string): Promise<T> {
  const file = join(DIST, rel);
  if (!existsSync(file)) throw new Error(`live-shape launcher: ${file} is missing; run \`pnpm --filter @bs-job-agents/orchestrator build\` first`);
  return (await import(file)) as T;
}

const { startOrchestrator } = await fromDist<typeof StartModule>("api/boot/start.js");
const { resolveConfig } = await fromDist<typeof ConfigModule>("config.js");
const { FakeRunner, FakeBrowserProbe, FakeFigmaPort, MemoryFileStore, defaultFakeResult, fake } = await fromDist<typeof TestingModule>("engine/testing/index.js");
const { fakeCaptures } = await fromDist<typeof FakeRunnerModule>("engine/testing/fake-runner.js");
const { LeadMcpRunner } = await fromDist<typeof McpModule>("mcp/index.js");

type Orchestrator = StartModule.Orchestrator;
type FakeRunnerT = TestingModule.FakeRunner;

const ORCH_PORT = Number(process.env.E2E_ORCH_PORT ?? 4199);
const CONTROL_PORT = Number(process.env.E2E_CONTROL_PORT ?? 4198);
const realClock = { sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) };
/** Each fake bot task takes a moment, so the UI sees queued → running → done over SSE. */
const STEP_MS = Number(process.env.E2E_STEP_MS ?? 400);

/** Screenshots the runner's capture pipeline would leave (PM2 S7), on the real disk. */
const diskSink = {
  write(path: string, content: string | Buffer) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  },
  read(path: string) {
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  },
};

/** One-page A4 PDF with the frame's name and a few lines, so the web viewer renders a real CV. */
async function cvPdf(frameName: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  page.drawText("BA HUYNH", { x: 56, y: 770, size: 26, font: bold });
  page.drawText("Software Engineer - React / Next.js / Node.js", { x: 56, y: 744, size: 12, font });
  page.drawText(`Tailored CV ${frameName}`, { x: 56, y: 720, size: 9, font });
  const lines = ["Owned a React/Node.js product end to end at Gradion", "Built payment flows with Next.js and TypeScript", "Led code review and release process for 3 apps"];
  lines.forEach((line, i) => page.drawText(`- ${line}`, { x: 56, y: 680 - i * 18, size: 11, font }));
  doc.setTitle(frameName);
  doc.setCreationDate(new Date("2026-10-11T03:00:00Z"));
  doc.setModificationDate(new Date("2026-10-11T03:00:00Z"));
  return doc.save();
}

class DiskFigmaPort extends FakeFigmaPort {
  constructor() {
    super(new MemoryFileStore());
  }

  override async exportFramePdf(frameId: string, outPath: string): Promise<{ sha256: string; pageCount: number; onePageA4: boolean }> {
    await super.exportFramePdf(frameId, outPath);
    const name = outPath.split("/").at(-1)!.replace(/\.pdf$/, "");
    const bytes = Buffer.from(await cvPdf(name));
    diskSink.write(outPath, bytes);
    return { sha256: MemoryFileStore.sha256Of(bytes), pageCount: 1, onePageA4: true };
  }
}

const textOf = (task: RunnerTask): string => String((task.input as { text?: unknown } | null)?.text ?? "");

/** Tasks that already hit their one usage limit ([usage-limit] in Ba's message). */
const limited = new Set<number>();

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
  const text = res.content.map((c) => c.text).join("\n");
  if (res.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

const NO_CRITERIA_CHANGES = {
  roles: null,
  locations: null,
  includeKeywords: null,
  excludeKeywords: null,
  excludeCompanies: null,
  companyTypes: null,
  workModes: null,
  seniority: null,
  sources: null,
  minSalary: null,
  maxJobs: null,
  fitThreshold: null,
};

/** What the fake Lead does for Ba's message: MCP tool calls first (like claude -p), then its output. */
async function leadReply(task: RunnerTask, orchestrator: McpServerConfig): Promise<RunnerResult> {
  const text = textOf(task);
  const lower = text.toLowerCase();
  if (lower.includes("[usage-limit]") && !limited.has(task.taskId)) {
    limited.add(task.taskId);
    return fake.usageLimit("claude", new Date(Date.now() + Number(process.env.E2E_USAGE_RESET_MS ?? 6000)).toISOString());
  }
  const client = new Client({ name: "fake-claude-lead", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL((orchestrator as { url: string }).url)));
  const output: Omit<LeadOutput, "selfCheck" | "memoryNotes"> = { reply: "Hi Ba. Tell me what to look for, or ask me to scan.", actions: [] };
  try {
    if (/\bscan\b|find .*jobs/.test(lower) && !lower.includes("every weekday")) {
      await callTool(client, "message_user", { text: "Starting a job scan on TopCV and ITviec…" });
      await realClock.sleep(STEP_MS);
      const r = await callTool(client, "start_workflow", { workflow: "job-scan", params: { searchProfileId: null, overrides: null } });
      output.reply = "Research is scanning TopCV and ITviec. I'll put the jobs that fit in your review queue.";
      output.actions.push({ type: "start_workflow", workflow: "job-scan", runId: r.runId === undefined ? null : String(r.runId), summary: "Scan TopCV + ITviec for frontend jobs" });
    } else if (lower.includes("đà nẵng") || lower.includes("da nang")) {
      output.reply = "I can add Đà Nẵng to your locations. Just this run, or save it to your criteria?";
      output.actions.push({ type: "propose_criteria_change", changes: { ...NO_CRITERIA_CHANGES, locations: { add: ["Đà Nẵng"], remove: [] } } });
    } else if (lower.includes("every weekday")) {
      output.reply = "Here's a schedule for that. Create it?";
      output.actions.push({ type: "propose_schedule", schedule: { name: "Weekday morning scan", repeat: "weekdays", day: null, time: "09:00", searchProfileId: null } });
    } else if (lower.includes("[usage-limit]")) {
      output.reply = "Back after the usage pause. What should I look for?";
    }
  } finally {
    await client.close();
  }
  return { status: "ok", output: withEnvelope(task, output), sessionId: null, durationMs: 800 };
}

function withEnvelope(task: RunnerTask, output: Omit<LeadOutput, "selfCheck" | "memoryNotes">): LeadOutput {
  // The default result carries the self-check items Lead's bot.json requires (rule 4).
  const base = defaultFakeResult(task);
  const selfCheck = base.status === "ok" ? (base.output as LeadOutput).selfCheck : [];
  return { ...output, selfCheck, memoryNotes: [] };
}

/** UC-12: the first Apply on Kite Labs stops with a required question. */
function needsAnswer(task: RunnerTask): boolean {
  const input = task.input as { expectedCompany?: string; answers?: unknown[] };
  return input.expectedCompany === "Kite Labs" && (input.answers?.length ?? 0) === 0;
}

function scriptedRunner(engine: "claude" | "codex"): FakeRunnerT {
  const runner = new FakeRunner({ engine, clock: realClock, screenshots: diskSink });
  runner.script(
    // Every task takes STEP_MS (default outputs, shaped by the input).
    { scenario: "slow default", delayMs: STEP_MS },
    { bot: "research", kind: "scan", delayMs: STEP_MS, result: (task) => ({ status: "ok", output: { ...scanOutputFor(task), selfCheck: selfCheckOf(task) }, sessionId: null, durationMs: STEP_MS }) },
    {
      bot: "apply",
      kind: "submit",
      delayMs: STEP_MS * 2,
      result: (task) => applyResult(task),
    },
    {
      bot: "apply",
      kind: "submit",
      scenario: "UC-12 required question",
      when: needsAnswer,
      delayMs: STEP_MS,
      result: fake.applyPaused({
        questions: [{ field: "notice_period", label: "Notice period (weeks)", required: true, kind: "text", options: null }],
      }),
    },
  );
  return runner;
}

function selfCheckOf(task: RunnerTask) {
  const base = defaultFakeResult(task);
  return base.status === "ok" ? (base.output as { selfCheck: unknown[] }).selfCheck : [];
}

/** Apply's default output with real PNG captures (pre-submit, confirmation, JD page) in its screenshot folder. */
function applyResult(task: RunnerTask): RunnerResult {
  const base = defaultFakeResult(task);
  if (base.status !== "ok" || !task.screenshotDir) return base;
  const out = base.output as ApplyOutput;
  const shots: { id: string; bytes: Buffer }[] = [];
  if (out.jdSnapshot?.pageScreenshot) shots.push({ id: out.jdSnapshot.pageScreenshot, bytes: fakeFormScreenshot([90, 110, 160], 3) });
  if (out.preSubmitScreenshot) shots.push({ id: out.preSubmitScreenshot, bytes: fakeFormScreenshot([37, 99, 235]) });
  if (out.confirmationScreenshot) shots.push({ id: out.confirmationScreenshot, bytes: fakeFormScreenshot([22, 163, 74], 1) });
  return { ...base, screenshots: fakeCaptures(diskSink, task.screenshotDir, shots) };
}

interface Running {
  orch: Orchestrator;
  root: string;
  runners: FakeRunnerT[];
}

let current: Running | null = null;

async function boot(): Promise<Running> {
  const root = mkdtempSync(join(tmpdir(), "bsja-live-shape-"));
  const dataDir = join(root, "data");
  const botsDir = join(root, "bots");
  mkdirSync(dataDir, { recursive: true });
  // Bots' memory files are written during runs: never touch the repo's own bots/.
  cpSync(join(REPO, "bots"), botsDir, { recursive: true });
  cpSync(join(REPO, "data.example", "master-cv.yaml"), join(dataDir, "master-cv.yaml"));
  const config = { ...resolveConfig({ ORCH_WEB_ORIGINS: process.env.ORCH_WEB_ORIGINS ?? "" }, REPO), port: ORCH_PORT, dataDir, botsDir, workflowsDir: join(REPO, "workflows") };
  const claude = scriptedRunner("claude");
  const codex = scriptedRunner("codex");
  const orch = await startOrchestrator({
    config,
    logger: process.env.E2E_ORCH_LOG === "1" ? { level: "info" } : false,
    runners: ({ capabilities, server }) => ({
      claude: new LeadMcpRunner(claude, {
        capabilities,
        server,
        // Stands in for `claude -p` with the per-spawn mcp.json: it calls the six tools over HTTP.
        spawnRunner: (orchestrator): Runner => ({
          engine: "claude",
          run: async (task, onEvent) => {
            claude.calls.push(task);
            onEvent({ type: "started", engine: "claude", sessionId: `fake-lead-${task.taskId}-${task.attempt}`, pid: 0 });
            await realClock.sleep(STEP_MS);
            return leadReply(task, orchestrator);
          },
        }),
      }),
      codex,
    }),
    notify: null,
    figma: new DiskFigmaPort(),
    browser: new FakeBrowserProbe(),
    lockWaitMs: 2000,
    shutdownGraceMs: 2000,
  });
  if (orch.ctx.state.state !== "running") throw new Error(`live-shape orchestrator degraded: ${JSON.stringify(orch.ctx.state)}`);
  await orch.listen();
  // Ba's saved criteria, through the API like the Criteria screen (first save).
  const origin = config.webOrigins[0]!;
  const res = await orch.app.inject({
    method: "PUT",
    url: "/criteria",
    headers: { host: `127.0.0.1:${ORCH_PORT}`, origin, "x-bsja-csrf": "1", "content-type": "application/json" },
    payload: JSON.stringify(LIVE_SHAPE_CRITERIA),
  });
  if (res.statusCode !== 200) throw new Error(`live-shape: seeding criteria failed (${res.statusCode}): ${res.body}`);
  return { orch, root, runners: [claude, codex] };
}

async function shutdown(): Promise<void> {
  const r = current;
  current = null;
  if (!r) return;
  await r.orch.close();
  rmSync(r.root, { recursive: true, force: true });
  limited.clear();
}

let queue: Promise<unknown> = Promise.resolve();
/** Resets run one at a time. */
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
};

const control = createServer((req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  void (async () => {
    try {
      if (req.method === "GET" && req.url === "/ready") return send(current ? 200 : 503, { ready: current !== null });
      if (req.method === "POST" && req.url === "/reset") {
        const r = await serial(async () => {
          await shutdown();
          current = await boot();
          return current;
        });
        return send(200, { dataDir: r.orch.ctx.config.dataDir });
      }
      if (req.method === "GET" && req.url === "/calls") {
        const calls = (current?.runners ?? []).flatMap((r) => r.calls).map((c) => ({ key: `${c.bot.name}.${c.kind}`, taskId: c.taskId, attempt: c.attempt, input: c.input }));
        return send(200, calls);
      }
      send(404, { error: "not found" });
    } catch (err) {
      send(500, { error: err instanceof Error ? err.message : String(err) });
    }
  })();
});

current = await boot();
control.listen(CONTROL_PORT, "127.0.0.1", () => {
  console.info(`live-shape: orchestrator on 127.0.0.1:${ORCH_PORT} (FakeRunner), control on 127.0.0.1:${CONTROL_PORT}`);
});

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    control.close();
    void shutdown().finally(() => process.exit(0));
  });
}
