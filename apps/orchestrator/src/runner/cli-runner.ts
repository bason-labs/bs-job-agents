// The engine-independent part of a run (spec §5.5): checks before spawning (fail closed),
// one CLI call, at most one repair prompt in the same session, and the mapping to RunnerResult.
// ClaudeRunner and CodexRunner plug in their command lines and stream parsers.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
  BOT_TASK_KINDS,
  CONVERSATION_TASK_KINDS,
  DomainSchema,
  findForbiddenPromptKeys,
  getBotOutputJsonSchema,
  promptInputSchemaFor,
  resolveOutputSchemaName,
  resolveSelfCheckItems,
  type BotOutputSchemaName,
  type Engine,
  type JsonSchema,
} from "@bs-job-agents/shared";
import { assertRunnableBot, readBotPromptFiles } from "./bots.js";
import type { RunnerConfig } from "./config.js";
import { TaskSetupError } from "./errors.js";
import type { Invocation } from "./invocation.js";
import { checkOutput, failedSelfCheckItems, repairPrompt, type OutputCheck } from "./output.js";
import { killProcessGroup, nodeSpawn, runCli, type CliExit, type KillTreeFn, type SpawnFn } from "./process.js";
import { buildPrompt, PromptSecurityError } from "./prompt.js";
import { conversationPlan, planTools, type ToolPlan } from "./tools.js";
import { PageUrlCollector } from "./page-urls.js";
import { ScreenshotCapture } from "./screenshots.js";
import { TranscriptWriter } from "./transcript.js";
import type { PermissionDenial, Runner, RunnerAttachment, RunnerEvent, RunnerResult, RunnerTask } from "./types.js";

export interface RunnerDeps {
  spawn?: SpawnFn;
  killTree?: KillTreeFn;
  /** Epoch ms. */
  now?: () => number;
  randomUUID?: () => string;
  /** Codex browser bots: Ba's plugins to disable (default: read from his Codex config). */
  codexPluginsToDisable?: () => string[];
  /** Codex browser bots: Ba's MCP servers to switch off (default: read from his Codex config, PM2 M3). */
  codexMcpServersToDisable?: () => string[];
}

/** Everything a run needs once the checks passed. */
export interface PreparedTask {
  task: RunnerTask;
  plan: ToolPlan;
  schemaName: BotOutputSchemaName;
  schema: JsonSchema;
  selfCheckItems: string[];
  prompt: string;
  readDirs: string[];
  allowedSites: string[];
  /** F8: the files Ba attached (checked), and the one folder that holds them (null: none). */
  attachments: RunnerAttachment[];
  attachmentDir: string | null;
  workDir: string;
  /** Claude: chosen up front (--session-id). Codex: null until thread.started. */
  sessionId: string | null;
  /** PM2 S7: screenshots out of the stream (and base64 out of the transcript). */
  capture: ScreenshotCapture;
  /** PM2 S10: the page URLs Chrome reported. */
  pages: PageUrlCollector;
}

export type Phase = "initial" | "repair";

/** What one CLI call produced, in engine-independent terms. */
export interface AttemptReport {
  sessionId: string | null;
  /** undefined = no output at all. */
  value: unknown;
  raw: string | null;
  /** The output exists but is not JSON. */
  parseError: string | null;
  /** The run failed (API error, turn.failed, crash); null when it completed. */
  failure: string | null;
  /** A subscription limit stopped or threatens this engine. */
  limit: { resetsAt: string | null } | null;
  denials: PermissionDenial[];
}

/** Engine side of one CLI call: parses stdout lines, then reports after exit. */
export interface EngineSession {
  push(line: string): RunnerEvent[];
  finish(exit: CliExit, stderr: readonly string[]): Promise<AttemptReport>;
}

const STDERR_TAIL = 5;

export function stderrTail(stderr: readonly string[]): string {
  return stderr.slice(-STDERR_TAIL).join(" | ");
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export abstract class CliRunner implements Runner {
  abstract readonly engine: Engine;
  protected readonly spawn: SpawnFn;
  protected readonly killTree: KillTreeFn;
  protected readonly now: () => number;
  protected readonly uuid: () => string;

  constructor(
    protected readonly config: RunnerConfig,
    protected readonly deps: RunnerDeps = {},
  ) {
    this.spawn = deps.spawn ?? nodeSpawn;
    this.killTree = deps.killTree ?? killProcessGroup;
    this.now = deps.now ?? Date.now;
    this.uuid = deps.randomUUID ?? randomUUID;
  }

  protected abstract initialInvocation(p: PreparedTask): Invocation;
  protected abstract repairInvocation(p: PreparedTask, sessionId: string, prompt: string): Invocation;
  protected abstract openSession(p: PreparedTask, phase: Phase, pid: number | null): EngineSession;
  /** Delete the persisted CLI session (kept only for the repair prompt). Best effort. `cwd`: where a CLI call runs. */
  protected abstract deleteSession(sessionId: string, cwd: string): Promise<void>;

  /** UC-18: delete a session a crashed orchestrator left behind (Runner.removeSession). */
  removeSession(sessionId: string): Promise<void> {
    return this.deleteSession(sessionId, this.config.tmpRoot);
  }
  /** Claude chooses the session id up front (--session-id); Codex learns it from thread.started. */
  protected abstract initialSessionId(): string | null;

  async run(task: RunnerTask, onEvent: (event: RunnerEvent) => void): Promise<RunnerResult> {
    const t0 = this.now();
    const durationMs = () => Math.max(0, this.now() - t0);
    if (task.signal?.aborted) return { status: "cancelled", durationMs: 0 };
    const emit = (e: RunnerEvent) => {
      try {
        onEvent(e);
      } catch {
        // A listener bug must never break a running task.
      }
    };

    let transcript: TranscriptWriter;
    try {
      transcript = await TranscriptWriter.open(task.transcriptPath);
    } catch (err) {
      return { status: "failed", error: `cannot open the transcript ${task.transcriptPath}: ${message(err)}`, exitCode: null, durationMs: durationMs() };
    }

    let prepared: PreparedTask | null = null;
    try {
      prepared = await this.prepare(task);
    } catch (err) {
      transcript.note({ type: "runner.refused", error: message(err) });
      transcript.note({ type: "runner.result", status: "failed" });
      await transcript.close();
      return { status: "failed", error: message(err), exitCode: null, durationMs: durationMs() };
    }

    let result: RunnerResult;
    try {
      // The deadline is on the real clock (the process timers use it); `now` only measures durations.
      result = await this.execute(prepared, transcript, emit, Date.now() + task.timeoutMs - durationMs(), durationMs);
    } catch (err) {
      result = { status: "failed", error: `runner error: ${message(err)}`, exitCode: null, durationMs: durationMs() };
    }
    // PM2 S7, S10: what the Chrome tools produced, whatever the result (an Apply that failed may have submitted).
    try {
      await prepared.capture.finish();
    } catch (err) {
      transcript.note({ type: "runner.screenshots", error: message(err) });
    }
    const screenshots = prepared.capture.captured;
    const pageUrls = prepared.pages.urls;
    if (screenshots.length > 0) {
      result = { ...result, screenshots: [...screenshots] };
      transcript.note({ type: "runner.screenshots", files: screenshots.map((s) => ({ file: s.file, screenshotId: s.screenshotId, toolUseId: s.toolUseId })) });
    }
    if (pageUrls.length > 0) result = { ...result, pageUrls: [...pageUrls] };
    if (prepared.pages.visits.length > 0) result = { ...result, pageVisits: [...prepared.pages.visits] };
    transcript.note({ type: "runner.result", status: result.status });
    await transcript.close();
    await rm(prepared.workDir, { recursive: true, force: true }).catch(() => undefined);
    if (this.config.cleanupSessions && prepared.sessionId) {
      await this.deleteSession(prepared.sessionId, prepared.task.cwd).catch(() => undefined);
    }
    return result;
  }

  // ------------------------------------------------------------------ checks before spawning

  private async prepare(task: RunnerTask): Promise<PreparedTask> {
    const bot = task.bot;
    if (bot.engine !== this.engine) throw new TaskSetupError(`bot ${bot.name} runs on ${bot.engine}, not ${this.engine}`);
    // Owner decision 2026-10-11: a Figma bot runs on Codex only with Ba's opt-in (the engine
    // passes it from bots.engine_risk_ack_at); Codex has no hooks, so none is required there.
    assertRunnableBot(bot, bot.name, { unguardedFigmaAcknowledged: this.engine === "codex" && task.unguardedFigmaAcknowledged === true });
    const forbidden = findForbiddenPromptKeys(task.input);
    if (forbidden.length > 0) {
      throw new PromptSecurityError(`task input carries guard-only fields that must never reach a model: ${forbidden.join(", ")}`);
    }
    const knownKinds = (BOT_TASK_KINDS as Record<string, readonly string[]>)[bot.name];
    if (knownKinds && ![...knownKinds, ...CONVERSATION_TASK_KINDS].includes(task.kind)) {
      throw new TaskSetupError(`bot ${bot.name} has no task kind "${task.kind}" (known: ${[...knownKinds, ...CONVERSATION_TASK_KINDS].join(", ")})`);
    }
    let schemaName: BotOutputSchemaName;
    try {
      schemaName = resolveOutputSchemaName(bot, task.kind);
    } catch (err) {
      throw new TaskSetupError(message(err));
    }
    const inputSchema = promptInputSchemaFor(bot.name, task.kind);
    if (inputSchema) {
      const parsed = inputSchema.safeParse(task.input);
      if (!parsed.success) {
        const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
        throw new TaskSetupError(`task input does not match ${bot.name}.${task.kind}: ${issues.join("; ")}`);
      }
    }
    const conversation = (CONVERSATION_TASK_KINDS as readonly string[]).includes(task.kind);
    const fullPlan = planTools(bot);
    let plan = conversation ? conversationPlan(fullPlan) : fullPlan;
    // §10.3: only a task that holds the browser lock may drive Ba's Chrome.
    if (task.usesBrowser === false && plan.chrome) plan = { ...plan, chrome: null };
    const readDirs = checkReadDirs(task.readDirs ?? []);
    const { attachments, dir: attachmentDir } = checkAttachments(task, conversation || (bot.name === "lead" && task.kind === "chat"));
    const allowedSites = plan.chrome ? checkSites(task) : [];
    const { roleMd, memoryMd } = readBotPromptFiles(task.cwd);
    const selfCheckItems = resolveSelfCheckItems(bot, task.kind);
    const prompt = buildPrompt({
      bot,
      kind: task.kind,
      engine: this.engine,
      input: task.input,
      roleMd,
      memoryMd,
      schemaName,
      selfCheckItems,
      allowedSites,
      readDirs: plan.read ? readDirs : [],
      attachments,
    });
    if (task.screenshotDir !== undefined && (!isAbsolute(task.screenshotDir) || /[\s,()]/.test(task.screenshotDir))) {
      throw new TaskSetupError(`screenshot dir ${task.screenshotDir} must be an absolute path without a space, a comma or a parenthesis`);
    }
    // PM2 S7: only a task that drives Chrome on Claude keeps its screenshots.
    const capture = await ScreenshotCapture.open(plan.chrome && this.engine === "claude" ? (task.screenshotDir ?? null) : null, { now: this.now });
    const workDir = await mkdtemp(join(this.config.tmpRoot, `bsja-${bot.name}-${task.taskId}-${task.attempt}-`));
    const prepared: PreparedTask = {
      task,
      plan,
      schemaName,
      schema: getBotOutputJsonSchema(schemaName),
      selfCheckItems,
      prompt,
      readDirs,
      allowedSites,
      attachments,
      attachmentDir,
      workDir,
      sessionId: this.initialSessionId(),
      capture,
      pages: new PageUrlCollector(this.now),
    };
    try {
      // Build once now so a missing MCP server or guard hook fails before anything runs.
      this.initialInvocation(prepared);
    } catch (err) {
      await rm(workDir, { recursive: true, force: true });
      throw err;
    }
    return prepared;
  }

  // ------------------------------------------------------------------ the run

  private async execute(
    p: PreparedTask,
    transcript: TranscriptWriter,
    emit: (e: RunnerEvent) => void,
    deadline: number,
    durationMs: () => number,
  ): Promise<RunnerResult> {
    const first = await this.invoke(p, this.initialInvocation(p), "initial", transcript, emit, deadline);
    const early = this.outcome(p, first.exit, first.report, durationMs);
    if (early) return early;

    let check = this.check(p, first.report);
    if (!check.ok) {
      const sessionId = p.sessionId;
      if (!sessionId) return { status: "invalid_output", errors: check.errors, raw: first.report.raw, durationMs: durationMs() };
      const errors = check.errors;
      emit({
        type: "progress",
        text: `Output did not pass validation (${errors.length} issue${errors.length === 1 ? "" : "s"}); one repair prompt in the same session.`,
      });
      transcript.note({ type: "runner.repair", errors });
      const prompt = repairPrompt({ schemaName: p.schemaName, errors, missing: check.missing, engine: this.engine });
      const second = await this.invoke(p, this.repairInvocation(p, sessionId, prompt), "repair", transcript, emit, deadline);
      const late = this.outcome(p, second.exit, second.report, durationMs);
      if (late?.status === "failed") {
        return { status: "invalid_output", errors: [...errors, `repair failed: ${late.error}`], raw: first.report.raw, durationMs: durationMs() };
      }
      if (late) return late;
      check = this.check(p, second.report);
      if (!check.ok) return { status: "invalid_output", errors: check.errors, raw: second.report.raw, durationMs: durationMs() };
    }

    const failed = failedSelfCheckItems(check.output);
    if (failed.length > 0) return { status: "self_check_failed", output: check.output, failed, durationMs: durationMs() };
    return { status: "ok", output: check.output, sessionId: p.sessionId, durationMs: durationMs() };
  }

  /**
   * Results that end the attempt after a CLI call, in priority order: cancel, timeout, a CLI
   * that would not start, a usage limit with no output, real denials (a safety signal even when
   * the run also failed), then a failure the CLI reported with no output. A run that simply
   * ended without output is not a failure: it gets the repair prompt (§5.5 step 4).
   */
  private outcome(p: PreparedTask, exit: CliExit, r: AttemptReport, durationMs: () => number): RunnerResult | null {
    if (exit.cancelled) return { status: "cancelled", durationMs: durationMs() };
    if (exit.timedOut) return { status: "timeout", durationMs: durationMs() };
    if (exit.spawnError) return { status: "failed", error: `cannot start the ${this.engine} CLI: ${exit.spawnError}`, exitCode: null, durationMs: durationMs() };
    if (r.limit && r.value === undefined) return { status: "usage_limit", engine: this.engine, resetsAt: r.limit.resetsAt, durationMs: durationMs() };
    if (r.denials.length > 0) {
      const c = this.check(p, r);
      return { status: "denied", denials: r.denials, output: c.ok ? c.output : null, durationMs: durationMs() };
    }
    if (r.value === undefined && r.parseError === null && r.failure) {
      return { status: "failed", error: r.failure, exitCode: exit.exitCode, durationMs: durationMs() };
    }
    return null;
  }

  private check(p: PreparedTask, r: AttemptReport): OutputCheck {
    if (r.parseError) return { ok: false, missing: false, errors: [r.parseError] };
    return checkOutput(p.schemaName, r.value, p.selfCheckItems);
  }

  private async invoke(
    p: PreparedTask,
    inv: Invocation,
    phase: Phase,
    transcript: TranscriptWriter,
    emit: (e: RunnerEvent) => void,
    deadline: number,
  ): Promise<{ exit: CliExit; report: AttemptReport }> {
    for (const [path, content] of Object.entries(inv.files)) await writeFile(path, content);
    transcript.note({ type: "runner.spawn", phase, engine: this.engine, command: inv.command, args: inv.display });
    const stderr: string[] = [];
    let session: EngineSession | null = null;
    const exit = await runCli({
      command: inv.command,
      args: inv.args,
      cwd: p.task.cwd,
      env: this.config.env,
      spawn: this.spawn,
      killTree: this.killTree,
      deadline,
      signal: p.task.signal,
      killGraceMs: this.config.killGraceMs,
      onSpawn: (pid) => {
        session = this.openSession(p, phase, pid);
      },
      onStdoutLine: (raw) => {
        // PM2 S7: image bytes become files (or are dropped) before the line is kept anywhere.
        const line = p.capture.process(raw);
        p.pages.push(line);
        transcript.raw(line);
        for (const e of session?.push(line) ?? []) emit(e);
      },
      onStderrLine: (line) => {
        if (!line.trim()) return;
        stderr.push(line);
        transcript.note({ type: "runner.stderr", phase, text: line });
      },
    });
    transcript.note({
      type: "runner.exit",
      phase,
      exitCode: exit.exitCode,
      signal: exit.signal,
      timedOut: exit.timedOut,
      cancelled: exit.cancelled,
      spawnError: exit.spawnError,
    });
    const opened = session as EngineSession | null;
    const report: AttemptReport = opened
      ? await opened.finish(exit, stderr)
      : { sessionId: null, value: undefined, raw: null, parseError: null, failure: exit.spawnError ?? "not started", limit: null, denials: [] };
    // The CLI's own session id is the truth (Claude echoes our --session-id; Codex names its thread).
    if (phase === "initial" && report.sessionId) p.sessionId = report.sessionId;
    return { exit, report };
  }
}

// ------------------------------------------------------------------ task checks

/** Read dirs: absolute, and no whitespace, comma or parenthesis (they become `Read(//dir/**)` rules). */
function checkReadDirs(dirs: readonly string[]): string[] {
  for (const dir of dirs) {
    if (!isAbsolute(dir)) throw new TaskSetupError(`read dir ${dir} must be an absolute path`);
    if (/[\s,()]/.test(dir)) throw new TaskSetupError(`read dir ${dir} must not contain a space, a comma or a parenthesis`);
  }
  return [...dirs];
}

/** F8: the attachment types a bot may look at (Claude's Read shows images and PDFs; Codex takes images with -i). */
export const ATTACHMENT_MIMES = ["image/png", "image/jpeg", "application/pdf", "text/plain"] as const;
const ATTACHMENT_FILE = /^upload-[A-Za-z0-9_-]{1,40}\.(png|jpe?g|pdf|txt)$/;

/**
 * F8: attachments only on a conversation task (lead.chat, consult, discussion), every copy in one
 * folder the engine made for the task, named by the orchestrator, of a type the bot can view. The
 * folder is what Claude may Read; anything else is refused before a spawn (fail closed).
 */
function checkAttachments(task: RunnerTask, conversation: boolean): { attachments: RunnerAttachment[]; dir: string | null } {
  const list = task.attachments ?? [];
  if (list.length === 0) return { attachments: [], dir: null };
  if (!conversation) throw new TaskSetupError(`${task.bot.name}.${task.kind} takes no attachments: only Lead's chat, consult and discussion do`);
  const dir = dirname(list[0]!.path);
  for (const a of list) {
    if (!isAbsolute(a.path) || /[\s,()]/.test(a.path)) throw new TaskSetupError(`attachment ${a.path} must be an absolute path without a space, a comma or a parenthesis`);
    if (dirname(a.path) !== dir || !ATTACHMENT_FILE.test(basename(a.path))) throw new TaskSetupError(`attachment ${a.path} is not an orchestrator copy in ${dir}`);
    if (!(ATTACHMENT_MIMES as readonly string[]).includes(a.mime)) throw new TaskSetupError(`attachment ${basename(a.path)}: ${a.mime} cannot be shown to a bot`);
  }
  return { attachments: list.map((a) => ({ ...a })), dir };
}

/** Sites a browser task may open: the task's list (Apply: the approval's domains) or the bot's list. */
function checkSites(task: RunnerTask): string[] {
  const browser = task.bot.browser;
  const sites = task.allowedSites ?? (browser?.sitesFromApproval ? [] : browser?.allowedSites ?? []);
  if (sites.length === 0) {
    throw new TaskSetupError(
      browser?.sitesFromApproval
        ? `${task.bot.name} needs at least one allowed site from the approval`
        : `${task.bot.name} needs at least one allowed site`,
    );
  }
  for (const site of sites) {
    if (!DomainSchema.safeParse(site).success) throw new TaskSetupError(`allowed site ${site} is not a host name`);
  }
  return [...sites];
}
