// The task queue (§4.2, §5.5, §10): claims runnable tasks within the per-engine caps, the browser
// lock and the Figma lock (§10.3), checks each one before it spawns (trust guard, Chrome / Figma
// bridge, read folders, Apply's token and file, guard hooks), runs it, and settles the result
// with the attempt policy: 2 attempts per task (§5.5 step 6), never for apply.submit once it
// started (PM FYI c). Locks live in memory; they are free after a restart because recovery runs
// first. The Figma lock covers the orchestrator's own fingerprint and export calls too.
import { join } from "node:path";
import {
  ALLOWED_UPLOAD_TYPES,
  EngineSchema,
  PauseReasonSchema,
  failedSelfChecks,
  isRetryableTask,
  normalizeHostName,
  parseBotOutput,
  publicHostProblem,
  resolveOutputSchemaName,
  taskKey,
  type ApplyOutput,
  type ResearchScanOutput,
  type ApplyPromptInput,
  type CvOutput,
  type Engine,
  type FactDraftOutput,
  type PauseReason,
  type QaOutput,
  type ResearchCompanyOutput,
  type ResearchFitOutput,
  type SafetyDenialReason,
} from "@bs-job-agents/shared";
import { CHROME_TOOL_PREFIX, evaluateChromeToolCall } from "../bridges/chrome/site-guard/guard.js";
import { isFigmaUnavailable } from "../bridges/figma/errors.js";
import { diffFingerprints, templatesFromFingerprint, type ProtectedPagesFingerprint } from "../bridges/figma/fingerprint.js";
import { mergeHookSettings, type ClaudeHookSettings } from "../bridges/hooks/settings.js";
import { pdfFileNameForFrame } from "../bridges/pdf/files.js";
import {
  claimNextTask,
  completeTask,
  ensureCompany,
  findCvVersionByPdfPath,
  getRun,
  getStep,
  getTask,
  holdEngineTasks,
  latestApprovalForApplication,
  listEvents,
  pauseTask,
  requeueTask,
  saveCompanyProfile,
  setJobFit,
  setTaskTranscriptPath,
  updateTaskInput,
  type Conn,
  type Task,
} from "../db/index.js";
import { SCREENSHOT_MANIFEST, readScreenshotManifest, type CapturedScreenshot } from "../runner/screenshots.js";
import type { PermissionDenial, RunnerEvent, RunnerResult, RunnerTask } from "../runner/types.js";
import {
  applyStoppedBeforeSpawn,
  flagApplyJob,
  isApplyPause,
  moveApplication,
  onApplyDone,
  onApplyFailedAfterSpawn,
  onApplyPaused,
  prepareApply,
  captureRecordFiles,
  type RecordFiles,
} from "./apply.js";
import { MASTER_CV_TASK_KEYS, effectiveBot, type EffectiveBot } from "./bots.js";
import { loadRunCtx, type RunCtx } from "./context.js";
import { announceSettledDryRun } from "./review.js";
import type { EngineCore } from "./core.js";
import { errorMessage } from "./errors.js";
import { onCheckerDone, onProducerDone, type CvExport } from "./gate.js";
import type { GuardBlock } from "./ports.js";
import { isConversationTask, sinkContext, sinkFailed } from "./conversations.js";
import { onFactDraftDone } from "./fact-drafts.js";
import { injectionDetail, reportedInjection } from "./injection.js";
import { DEMOTING_SAFETY_REASONS, demoteBot, postProtectedChangeAlert } from "./demotion.js";
import { noticePause, noticeTaskFailed } from "./notices.js";
import { emitSafetyDenied, emitTaskFinished, emitTaskPaused, failTaskNow, stillRunning } from "./task-events.js";
import { hostOfUrl, pauseSite, siteBlocksOf, siteKey, type SiteBlock } from "./sites.js";
import { adapterBrokenError, scanRejectedError, type ScanCheckResult } from "./scan-check.js";
import { checkTaskTrust } from "./trust-guard.js";
import { FeedTaskRunner } from "./feed-tasks.js";

const ENGINES = EngineSchema.options;

interface SafetyNote {
  reason: SafetyDenialReason;
  action: string;
  detail: string | null;
  /** A runner denial from a guard hook (the guard log has the same block). */
  fromHook?: boolean;
  /**
   * PM2 S8: false = logged, but not a violation by the bot's own conduct (its own injection report,
   * the after-the-fact URL check), so it never demotes the bot.
   */
  demote?: boolean;
}

/** What one attempt came to, after the engine checked the runner's result. */
export type Outcome =
  /**
   * `recordFiles`: apply.submit's screenshots as the record may cite them (PM2 M1, S7), checked
   * before settle. `recordCheck`: why the record must be needs_check whatever Apply said (PM2 S10).
   */
  | { kind: "ok"; output: unknown; safety?: SafetyNote[]; recordFiles?: RecordFiles; recordCheck?: string }
  /** The bot paused itself: a login, a CAPTCHA, questions, a domain to confirm (UC-03 a, UC-11, UC-12, UC-17). */
  | { kind: "paused"; reason: PauseReason; output: unknown; safety?: SafetyNote[] }
  | {
      kind: "failed";
      error: string;
      output?: unknown;
      retryable: boolean;
      safety?: SafetyNote[];
      /** The attempt also hit a usage limit: the engine still pauses (S3 turned it into a failure). */
      limit?: { engine: Engine; resetsAt: string | null };
    }
  | { kind: "usage_limit"; engine: Engine; resetsAt: string | null; safety?: SafetyNote[] }
  | { kind: "cancelled"; safety?: SafetyNote[] }
  /** Figma went away during the orchestrator's own calls: wait as needs_figma, then run again. */
  | { kind: "needs_figma"; detail: string; beforeHash: string | null; safety?: SafetyNote[] };

interface Prepared {
  runnerTask: RunnerTask;
  bot: EffectiveBot;
  /** CV tasks: the protected pages before the bot ran. */
  figmaBefore?: ProtectedPagesFingerprint;
  /** apply.submit: the trust guard's last step, run right before the spawn (consumes or re-validates the token). */
  authorize?: () => ApplyPromptInput | null;
  /** apply.submit passed the trust guard (a token was consumed or re-validated). */
  apply: boolean;
  /** Absolute JSONL log the guard hooks write their decisions to. */
  guardLog: string | null;
  /** Where this spawn's lines start in the guard log (a resume keeps the attempt, so the log holds earlier spawns' lines). */
  guardLogOffset: number;
  /** PM2 S7: absolute data/screenshots/<task>-<attempt>/ of a Claude browser task, else null. */
  screenshotDir: string | null;
}

interface Inflight {
  promise: Promise<void>;
  controller: AbortController;
  engine: Engine;
  /** Set once the runner was called: an Apply that spawned may have submitted. */
  spawned: boolean;
}

/** Where the orchestrator's own Figma calls went wrong. */
class FigmaGone extends Error {}

/** `upload-<id><ext>`: the file name's extension when UC-24 allows it for the mime type, else the type's own. */
export function uploadCopyName(file: { uploadId: string; filename: string; mime: string }): string {
  const id = file.uploadId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40) || "file";
  const allowed: readonly string[] = (ALLOWED_UPLOAD_TYPES as Record<string, readonly string[]>)[file.mime] ?? [];
  const fromName = /\.[A-Za-z0-9]{1,5}$/.exec(file.filename)?.[0]?.toLowerCase();
  return `upload-${id}${fromName && allowed.includes(fromName) ? fromName : (allowed[0] ?? "")}`;
}

/** The audit row a CV spawn writes with the protected pages' "before" hash (PM2 S4). */
export const FIGMA_BEFORE_EVENT = "figma.before";

/**
 * PM2 S4: the "before" hash of the protected Figma pages that this CV task last spawned with (its
 * after-check may never have run: a crash, Figma gone, a failed attempt), or null. The next spawn
 * and the start-up after a crash compare the pages with it.
 */
export function lastFigmaBeforeHash(conn: Conn, task: Pick<Task, "id" | "output">): string | null {
  const row = listEvents(conn, { taskId: task.id, types: [FIGMA_BEFORE_EVENT] }).at(-1);
  const fromAudit = (row?.payload as { hash?: unknown } | undefined)?.hash;
  if (typeof fromAudit === "string" && fromAudit !== "") return fromAudit;
  const fromWait = (task.output as { figmaBeforeHash?: unknown } | null)?.figmaBeforeHash;
  return typeof fromWait === "string" && fromWait !== "" ? fromWait : null;
}

/** UC-11 d: Apply's own check that the page shows the approved company and title failed. */
function pageMismatch(key: string, failed: readonly string[]): SafetyNote[] {
  if (key !== "apply.submit") return [];
  const item = failed.find((f) => /company/i.test(f) && /title/i.test(f));
  return item ? [{ reason: "page_mismatch", action: "apply.submit", detail: item }] : [];
}

/** §10.2 rules 7–8: a hook denial is the site guard (or the Figma guard); a permission denial is a tool outside the bot's list. */
function denialNote(d: PermissionDenial): SafetyNote {
  const hook = d.source === "hook";
  const reason: SafetyDenialReason = !hook ? "trust_level" : /figma/i.test(d.tool) ? "protected_page_blocked" : "off_allowlist";
  return { reason, action: d.tool, detail: d.reason ?? (hook ? "blocked by a guard hook" : "tool outside the bot's permissions"), fromHook: hook };
}

/** The guards' JSONL decision log (bridges/hooks/run.ts): every `decision: "block"` line. */
export function parseGuardLog(text: string | null): GuardBlock[] {
  if (!text) return [];
  const blocks: GuardBlock[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      if (e.decision !== "block") continue;
      const s = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
      blocks.push({ guard: s(e.guard) ?? "guard", tool: s(e.tool) ?? "unknown", rule: s(e.rule), reason: s(e.reason), target: s(e.target) });
    } catch {
      // A torn line is skipped; the hook still blocked the call.
    }
  }
  return blocks;
}

/** A PreToolUse block by the Figma guard (the Drafts-only hook, §6.2). */
function isFigmaGuardDenial(d: PermissionDenial): boolean {
  return d.source === "hook" && /figma/i.test(d.tool);
}

/**
 * Live run 1 (F5): after a CV task whose protected pages are verifiably unchanged, every
 * Figma-guard block is prevention that worked: logged as `figma_guard_blocked`, never a demotion.
 */
function figmaBlocksVerified(outcome: Outcome): Outcome {
  if (!outcome.safety?.some((s) => s.reason === "protected_page_blocked")) return outcome;
  const safety = outcome.safety.map((s): SafetyNote => (s.reason === "protected_page_blocked" ? { ...s, reason: "figma_guard_blocked", demote: false } : s));
  return { ...outcome, safety } as Outcome;
}

function blockNote(b: GuardBlock): SafetyNote {
  const reason: SafetyDenialReason = b.guard === "site" ? "off_allowlist" : b.guard === "figma" ? "protected_page_blocked" : "trust_level";
  const detail = [b.rule, b.target, b.reason].filter((x): x is string => x !== null).join(" · ");
  return { reason, action: b.tool, detail: detail || null };
}

export class TaskQueue {
  private readonly inflight = new Map<number, Inflight>();
  private browserLock: number | null = null;
  private figmaLock: number | null = null;
  private stopped = false;
  /** W5: research.scan of a feed source: fetched by the orchestrator, outside the engine caps. */
  readonly feeds: FeedTaskRunner;

  constructor(private readonly core: EngineCore) {
    this.feeds = new FeedTaskRunner(core);
  }

  running(engine?: Engine): number {
    let n = 0;
    for (const e of this.inflight.values()) if (engine === undefined || e.engine === engine) n++;
    return n;
  }

  locks(): { browser: number | null; figma: number | null } {
    return { browser: this.browserLock, figma: this.figmaLock };
  }

  stop(): void {
    this.stopped = true;
  }

  resume(): void {
    this.stopped = false;
  }

  abort(taskId: number): boolean {
    if (this.feeds.abort(taskId)) return true;
    const entry = this.inflight.get(taskId);
    if (!entry) return false;
    entry.controller.abort();
    return true;
  }

  /** Claim and start everything runnable now (sync). */
  dispatch(): void {
    if (this.stopped) return;
    this.feeds.dispatch();
    for (;;) {
      const engines = ENGINES.filter((e) => this.running(e) < this.core.config.engineCaps[e]);
      if (engines.length === 0) return;
      const task = claimNextTask(this.core.db, {
        engines,
        allowBrowser: this.browserLock === null,
        allowFigma: this.figmaLock === null,
        feedTasks: "exclude",
        now: this.core.now(),
      });
      if (!task) return;
      this.start(task);
    }
  }

  /** Resolves when nothing runs and nothing more can be claimed (tests; a clean stop). */
  async idle(): Promise<void> {
    for (let round = 0; round < 100_000; round++) {
      this.dispatch();
      const pending = [...this.inflight.values()].map((e) => e.promise).concat(this.feeds.pending());
      if (pending.length > 0) {
        await Promise.all(pending);
        continue;
      }
      await new Promise((resolve) => setImmediate(resolve));
      if (this.inflight.size === 0 && this.feeds.running() === 0) return;
    }
    throw new Error("the task queue did not become idle");
  }

  private start(task: Task): void {
    if (task.usesBrowser) this.browserLock = task.id;
    if (task.usesFigma) this.figmaLock = task.id;
    const entry: Inflight = { promise: Promise.resolve(), controller: new AbortController(), engine: task.engine, spawned: false };
    this.inflight.set(task.id, entry);
    entry.promise = this.execute(task, entry)
      .catch((err: unknown) => this.crash(task, entry, err))
      .finally(() => {
        this.inflight.delete(task.id);
        if (this.browserLock === task.id) this.browserLock = null;
        if (this.figmaLock === task.id) this.figmaLock = null;
        // Both never throw (Engine.advance / Engine.dispatch log instead): this promise must
        // never reject, or Node would treat it as an unhandled rejection.
        this.core.advance(task.runId);
        this.core.dispatch();
      });
  }

  // ------------------------------------------------------------------ one attempt

  private async execute(task: Task, entry: Inflight): Promise<void> {
    const core = this.core;
    const prepared = await this.prepare(task, entry.controller);
    if (!prepared) return;
    if (entry.controller.signal.aborted) {
      // Cancelled during the checks: nothing ran in this attempt (the token was not touched).
      core.db.transaction((tx) => {
        const current = getTask(tx, task.id);
        if (current?.status !== "running") return;
        failTaskNow(core, tx, current, "cancelled before it started");
        const appId = Number((task.input as { applicationId?: unknown } | null)?.applicationId);
        if (prepared.apply && Number.isInteger(appId)) {
          // A resumed Apply already filled part of the form in an earlier spawn: Ba checks it.
          const resumed = isApplyPause(task.output);
          moveApplication(core, tx, appId, resumed ? "needs_check" : "failed", resumed ? "cancelled before Apply could continue" : "cancelled before Apply started");
        }
      });
      return;
    }
    // apply.submit: the token is consumed (or re-validated) as the very last step before the spawn.
    if (prepared.authorize) {
      const input = prepared.authorize();
      if (input === null) return;
      prepared.runnerTask.input = input;
    }
    const { runnerTask, bot } = prepared;
    core.db.transaction((tx) => {
      setTaskTranscriptPath(tx, task.id, core.paths.transcript(task.id, task.attempt));
      // PM2 S4: persisted before the spawn, so a crash cannot lose what the pages looked like.
      if (prepared.figmaBefore) core.bus.audit(tx, FIGMA_BEFORE_EVENT, { hash: prepared.figmaBefore.hash, attempt: task.attempt }, { runId: task.runId, taskId: task.id });
      core.bus.emit(tx, {
        type: "task.started",
        taskId: String(task.id),
        runId: task.runId === null ? null : String(task.runId),
        stepId: task.stepId === null ? null : String(task.stepId),
        botName: task.botName,
        kind: task.kind,
        engine: bot.def.engine,
        attempt: task.attempt,
      });
    });
    core.bus.flush();
    let timedOut = false;
    // The runner times out first (RunnerTask.timeoutMs); this is the engine's backstop.
    const watchdog = core.clock.setTimer(runnerTask.timeoutMs + core.config.timeoutGraceMs, () => {
      timedOut = true;
      entry.controller.abort();
    });
    let result: RunnerResult;
    entry.spawned = true;
    try {
      result = await core.deps.runners[bot.def.engine].run(runnerTask, (e) => this.onRunnerEvent(task, bot, e));
    } catch (err) {
      result = { status: "failed", error: `runner error: ${errorMessage(err)}`, exitCode: null, durationMs: 0 };
    } finally {
      core.clock.clearTimer(watchdog);
    }
    if (timedOut && result.status === "cancelled") result = { status: "timeout", durationMs: result.durationMs };
    let outcome = this.classify(task, bot, result);
    const blocks = await this.readGuardLog(prepared);
    outcome = this.withGuardLog(outcome, blocks);
    outcome = this.checkSiteGuard(task, outcome, siteBlocksOf(blocks, result));
    outcome = this.checkInjectionReport(task, outcome);
    outcome = await this.checkScanOutput(task, prepared, outcome, result);
    if (prepared.apply) outcome = this.checkApplyPages(task, outcome, result);
    if (outcome.kind === "ok" && prepared.apply) {
      const appId = Number((task.input as { applicationId?: unknown } | null)?.applicationId);
      if (Number.isInteger(appId)) {
        const source = prepared.screenshotDir ? { dir: prepared.screenshotDir, captures: await this.capturesOf(prepared.screenshotDir, result) } : null;
        outcome = { ...outcome, recordFiles: await captureRecordFiles(core, appId, outcome.output as ApplyOutput, source) };
      }
    }
    let exported: CvExport | undefined;
    if (task.usesFigma) ({ outcome, exported } = await this.afterFigmaTask(task, prepared, outcome));
    this.settle(task, prepared, outcome, exported);
  }

  private async probe(fn: () => Promise<boolean>): Promise<boolean> {
    try {
      return await fn();
    } catch {
      return false;
    }
  }

  private async prepare(task: Task, controller: AbortController): Promise<Prepared | null> {
    const core = this.core;
    const key = taskKey(task.botName, task.kind);
    let bot: EffectiveBot;
    try {
      const current = effectiveBot(core.db, core.deps.bots, task.botName);
      // One task, one engine: the one it was queued on (caps and usage pauses count it there),
      // even if Ba switched the bot's engine since.
      bot = { ...current, def: { ...current.def, engine: task.engine } };
    } catch (err) {
      this.refuse(task, "trust_level", errorMessage(err));
      return null;
    }
    const trust = checkTaskTrust(bot, task.kind);
    if (!trust.ok) {
      this.refuse(task, trust.reason, trust.detail);
      return null;
    }
    // §10.3, UC-17: no Chrome or no Figma bridge → the task waits and resumes on reconnect.
    if (task.usesBrowser && !(await this.probe(() => core.deps.browser.isConnected(bot.def.engine)))) {
      this.waitBridge(task, "needs_browser");
      return null;
    }
    if (task.usesFigma) {
      const status = await core.deps.figma.status().catch((err: unknown) => ({ connected: false, message: errorMessage(err) }));
      if (!status.connected) {
        this.waitBridge(task, "needs_figma", { detail: status.message });
        return null;
      }
    }
    if (!stillRunning(core.db, task.id)) return null;

    const claude = bot.def.engine === "claude";
    const guardLog = claude ? core.paths.abs(core.paths.guardLog(task.id, task.attempt)) : null;
    const guardLogOffset = guardLog ? ((await core.deps.files.readText(guardLog).catch(() => null))?.length ?? 0) : 0;
    const hooks: ClaudeHookSettings[] = [];
    let input: unknown = task.input;
    let readDirs: string[] | undefined;
    let allowedSites: string[] | undefined;
    const taskDir = core.paths.abs(core.paths.taskDir(task.id));
    try {
      // A per-task read folder, so a bot never reads all of data/ (coordinator, W2b handoff).
      if (MASTER_CV_TASK_KEYS.includes(key)) {
        await core.deps.files.copy(core.deps.masterCv.path, join(taskDir, "master-cv.yaml"));
        readDirs = [taskDir];
      }
      if (key === "research.file") {
        const file = input as { uploadId: string; path: string; filename: string; mime: string };
        // PM2 M4: the copy is named by the orchestrator; Ba's file name (untrusted text) stays in
        // `filename`, which the prompt puts in an UNTRUSTED_CONTENT block, never in the path.
        const dest = join(taskDir, uploadCopyName(file));
        await core.deps.files.copy(core.paths.abs(file.path), dest);
        input = { ...file, path: dest };
        readDirs = [taskDir];
        core.db.transaction((tx) => updateTaskInput(tx, task.id, input));
      }
    } catch (err) {
      this.failBeforeSpawn(task, `could not prepare the task's read folder: ${errorMessage(err)}`);
      return null;
    }
    let authorize: (() => ApplyPromptInput | null) | undefined;
    if (trust.needsApproval) {
      const prep = await prepareApply(core, task);
      if (prep.kind === "stopped") return null;
      input = prep.input;
      readDirs = prep.readDirs;
      allowedSites = prep.allowedSites;
      authorize = prep.authorize;
    } else if (task.usesBrowser && bot.def.browser && !bot.def.browser.sitesFromApproval) {
      // Only a task that holds the browser lock drives Chrome (§10.3); the runner drops the
      // Chrome tools of the others (RunnerTask.usesBrowser).
      allowedSites = bot.def.browser.allowedSites;
    }
    // §4.4: on Claude the allowlist is enforced by the site guard hook (Apply: the token's domains;
    // a domain Ba adds mid-apply means a respawn with new settings, UC-11 e).
    if (claude && bot.def.browser && allowedSites && allowedSites.length > 0) {
      hooks.push(core.deps.guards.siteGuard({ allowedSites, logFile: guardLog! }));
    }

    // §6.2 CV flow, all under the Figma lock: Drafts page → "before" fingerprint → the templates
    // go in the input → the Drafts-only guard for this task.
    let figmaBefore: ProtectedPagesFingerprint | undefined;
    if (task.usesFigma) {
      try {
        const drafts = await core.deps.figma.ensureDraftsPage();
        figmaBefore = await core.deps.figma.fingerprintProtectedPages();
        // PM2 S4: compare with the hash this task last spawned with (persisted before every spawn):
        // an earlier spawn's after-check may never have run, so what changed since is unverified.
        const verified = lastFigmaBeforeHash(core.db, task);
        if (verified && verified !== figmaBefore.hash) {
          this.refuse(
            task,
            "protected_page_changed",
            "the protected Figma pages changed while this CV task waited (for Figma, after a restart or between attempts); check them before continuing",
          );
          return null;
        }
        if (key === "cv.tailor") {
          input = { ...(input as Record<string, unknown>), templates: templatesFromFingerprint(figmaBefore) };
          core.db.transaction((tx) => updateTaskInput(tx, task.id, input));
        }
        if (claude) {
          // The guard's policy goes outside the bot's read folder (that holds master-cv.yaml only).
          const guardDir = core.paths.abs(core.paths.guardDir(task.id));
          hooks.push(await core.deps.guards.figmaGuard({ fingerprint: figmaBefore, dir: guardDir, logFile: guardLog!, draftsPageId: drafts.id }));
        }
      } catch (err) {
        if (isFigmaUnavailable(err)) this.waitBridge(task, "needs_figma", { detail: `Figma went away: ${errorMessage(err)}` });
        else this.failBeforeSpawn(task, `Figma: ${errorMessage(err)}`);
        return null;
      }
    }
    if (!stillRunning(core.db, task.id)) return null;
    // PM2 S7: a Claude task that drives Chrome keeps its screenshots (Apply's record cites copies of them).
    const screenshotDir = claude && task.usesBrowser ? core.paths.abs(core.paths.screenshotDir(task.id, task.attempt)) : null;
    return {
      bot,
      apply: trust.needsApproval,
      guardLog,
      guardLogOffset,
      screenshotDir,
      ...(figmaBefore ? { figmaBefore } : {}),
      ...(authorize ? { authorize } : {}),
      runnerTask: {
        taskId: task.id,
        runId: task.runId,
        attempt: task.attempt,
        bot: bot.def,
        kind: task.kind,
        input,
        cwd: core.paths.botDir(task.botName),
        transcriptPath: core.paths.abs(core.paths.transcript(task.id, task.attempt)),
        ...(readDirs ? { readDirs } : {}),
        ...(allowedSites ? { allowedSites } : {}),
        usesBrowser: task.usesBrowser,
        ...(screenshotDir ? { screenshotDir } : {}),
        ...(hooks.length > 0 ? { hookSettings: mergeHookSettings(...hooks) } : {}),
        // Owner decision 2026-10-11: CV on Codex runs without the Figma hook only with Ba's opt-in
        // (the trust guard checked it above); the fingerprint before and after is the backstop. A
        // consult has no Figma tools at all, but its bot still carries the bridge in mcpServers.
        ...(!claude && bot.engineRiskAcknowledged ? { unguardedFigmaAcknowledged: true } : {}),
        timeoutMs: bot.def.timeoutSec * 1000,
        signal: controller.signal,
      },
    };
  }

  private onRunnerEvent(task: Task, bot: EffectiveBot, e: RunnerEvent): void {
    const core = this.core;
    const ref = { taskId: String(task.id), runId: task.runId === null ? null : String(task.runId), stepId: task.stepId === null ? null : String(task.stepId), botName: task.botName };
    try {
      switch (e.type) {
        case "started":
          // UC-18: the pid lets a restart find a CLI process group a crash left behind.
          core.bus.audit(core.db, "runner.spawned", { engine: e.engine, sessionId: e.sessionId, pid: e.pid }, { runId: task.runId, taskId: task.id });
          core.bus.emit(core.db, { type: "task.progress", ...ref, kind: "status", text: `${bot.def.displayName} started on ${e.engine}`, tool: null });
          break;
        case "progress":
          core.bus.emit(core.db, { type: "task.progress", ...ref, kind: "text", text: e.text, tool: null });
          break;
        case "tool":
          core.bus.emit(core.db, {
            type: "task.progress",
            ...ref,
            kind: e.status === "started" ? "tool_use" : "tool_result",
            text: e.summary ?? `${e.name}: ${e.status}`,
            tool: e.name,
          });
          break;
        case "usage": {
          core.bus.emit(core.db, { type: "engine.usage", engine: e.engine, usage: e.usage });
          const peak = Math.max(e.usage.fiveHour ?? 0, e.usage.sevenDay ?? 0);
          // UC-16: pause before the wall (≥ 0.95), or when the runner says the engine is limited,
          // even if this task's own result is ok.
          if (e.limited || peak >= core.config.usagePauseUtilization) {
            core.db.transaction((tx) => core.pauseEngineForLimit(tx, e.engine, e.usage.resetsAt));
          }
          break;
        }
      }
    } finally {
      core.bus.flush();
    }
  }

  // ------------------------------------------------------------------ the result

  /** What a bot reported as its own pause (UC-03 a, UC-11 a/b/e, UC-12, UC-17). Sites are plain hosts (PM2 M2). */
  private selfPause(task: Task, output: unknown): PauseReason | null {
    const key = taskKey(task.botName, task.kind);
    if (key === "research.scan" || key === "research.single" || key === "research.file") {
      const blocked = (output as { blocked?: { reason: "needs_login" | "captcha"; site: string; detail: string | null } | null }).blocked;
      if (!blocked) return null;
      // S1: Lead names the site in Ba's chat, so a bot-named host counts only when the task may open it.
      const allowed = [...(this.core.deps.bots.get(task.botName)?.browser?.allowedSites ?? []), ...[hostOfUrl((task.input as { url?: unknown } | null)?.url)].filter((h): h is string => h !== null)];
      return { code: blocked.reason, site: pauseSite(blocked.site, this.researchSite(task), allowed) ?? "unknown-site", detail: blocked.detail };
    }
    if (key === "apply.submit") {
      const o = output as ApplyOutput;
      if (o.status !== "paused") return null;
      const code = o.pauseReason?.reason ?? "needs_answer";
      const url = (task.input as { jobUrl?: string } | null)?.jobUrl;
      const jobHost = url ? hostOfUrl(url) : null;
      // domain_confirm keeps what Apply named (null too): checkSiteGuard compares it with the guard's blocks.
      const domains = (task.input as { allowedDomains?: unknown } | null)?.allowedDomains;
      const allowed = Array.isArray(domains) ? domains.filter((d): d is string => typeof d === "string") : [];
      const site = code === "domain_confirm" ? (o.pauseReason?.site ?? null) : code === "needs_answer" ? null : pauseSite(o.pauseReason?.site, jobHost, allowed);
      const reason = { code, site, detail: o.pauseReason?.detail ?? null };
      if (code === "domain_confirm") return reason as PauseReason;
      return PauseReasonSchema.safeParse(reason).success ? reason : { code: "needs_answer", site: null, detail: reason.detail };
    }
    return null;
  }

  /** The site a Research task works on, for a pause that named none: the single URL's host or the source's site. */
  private researchSite(task: Task): string | null {
    const input = (task.input ?? {}) as { url?: unknown; source?: unknown };
    const fromUrl = hostOfUrl(input.url);
    if (fromUrl) return fromUrl;
    if (typeof input.source !== "string") return null;
    const sites = this.core.deps.bots.get(task.botName)?.browser?.allowedSites ?? [];
    return sites.find((s) => s.split(".")[0] === input.source) ?? null;
  }

  /**
   * PM2 M2 and S3, after the guard log was read:
   * - Apply's domain_confirm pause is offered only for a host the site guard blocked in this
   *   attempt, and only when it is a public web site; the pause then names that host (lowercase,
   *   no www.). Anything else (a bot-named site with no matching block, e.g. `vn`) fails Apply:
   *   needs_check and a safety event. Ba can never be asked to widen the token to a site no
   *   navigation needed.
   * - Any other attempt with a site-guard block fails the task with no retry (decision 6, §10.2
   *   rule 7: the navigation stops the task). Figma-guard blocks are settled by the fingerprint
   *   check instead (afterFigmaTask, live run 1).
   */
  private checkSiteGuard(task: Task, outcome: Outcome, blocks: readonly SiteBlock[]): Outcome {
    const domainConfirm = outcome.kind === "paused" && outcome.reason.code === "domain_confirm";
    if (blocks.length === 0 && !domainConfirm) return outcome;
    // The exact hosts the guard blocked; Apply's name for one is matched without `www.`, but the
    // offer is always the exact blocked host, so a confirmation never widens to a parent domain.
    const hosts = [...new Set(blocks.map((b) => b.host).filter((h): h is string => h !== null))];
    if (outcome.kind === "paused" && domainConfirm) {
      const named = outcome.reason.site ? normalizeHostName(outcome.reason.site) : hosts.length === 1 ? hosts[0]! : null;
      const blocked = named === null ? undefined : hosts.find((h) => siteKey(h) === siteKey(named));
      const blockedText = hosts.length > 0 ? `the site guard blocked ${hosts.join(", ")}` : "the site guard blocked no navigation";
      let detail: string | null = null;
      if (named === null) detail = `Apply asked to confirm a domain without naming it, and ${blockedText} in this attempt`;
      else if (!blocked) detail = `Apply asked to confirm ${named}, but ${blockedText} in this attempt`;
      else {
        const problem = publicHostProblem(blocked);
        if (problem) detail = `Apply asked to confirm ${blocked}, which the site guard blocked, but ${problem}`;
      }
      if (detail === null) return { ...outcome, reason: { ...outcome.reason, site: blocked! } };
      return {
        kind: "failed",
        error: `domain not confirmed: ${detail}`,
        output: outcome.output,
        retryable: false,
        safety: [...(outcome.safety ?? []), { reason: "off_allowlist", action: "apply.domain_confirm", detail }],
      };
    }
    if (outcome.kind === "cancelled") return outcome;
    const where = hosts.length > 0 ? hosts.join(", ") : [...new Set(blocks.map((b) => b.tool))].join(", ");
    return {
      kind: "failed",
      error: `the site guard blocked ${where} (§10.2 rule 7): the task stops without a retry`,
      ...("output" in outcome && outcome.output !== undefined ? { output: outcome.output } : {}),
      retryable: false,
      ...(outcome.safety ? { safety: outcome.safety } : {}),
      ...(outcome.kind === "usage_limit" ? { limit: { engine: outcome.engine, resetsAt: outcome.resetsAt } } : {}),
    };
  }

  /**
   * PM2 S11 (§10.2 rule 4): the bot reported an injection attempt. It is logged as a safety event
   * (not a violation of its own, so no demotion). A paused Apply stops (needs_check, no retry): a
   * page that tries to instruct it is not one to keep filling in. A finished Apply is recorded as
   * needs_check (writeSubmissionRecord); Research's jobs are flagged when they are stored.
   */
  /**
   * PM3 S8: a research.scan output that passed its schema and self-check goes to the
   * ScanOutputChecker (W4a's adapters). A broken adapter fails the branch for good (UC-03 b); an
   * implausible output fails the attempt (retried). A checker error is logged and accepted.
   */
  private async checkScanOutput(task: Task, prepared: Prepared, outcome: Outcome, result: RunnerResult): Promise<Outcome> {
    if (outcome.kind !== "ok" || taskKey(task.botName, task.kind) !== "research.scan") return outcome;
    const checker = this.core.deps.scanChecker;
    if (!checker) return outcome;
    const input = task.input as { source?: unknown } | null;
    const captures = prepared.screenshotDir ? await this.capturesOf(prepared.screenshotDir, result) : [];
    let verdict: ScanCheckResult;
    try {
      verdict = await checker.check({
        taskId: task.id,
        runId: task.runId,
        attempt: task.attempt,
        engine: prepared.bot.def.engine,
        source: typeof input?.source === "string" ? input.source : "unknown",
        input: task.input,
        output: outcome.output as ResearchScanOutput,
        screenshots: captures.map((c) => this.core.paths.rel(join(prepared.screenshotDir!, c.file))),
        ...(result.pageVisits ? { pageVisits: result.pageVisits } : {}),
      });
    } catch (err) {
      this.core.log.warn(`scan check for task ${task.id} failed, output accepted: ${errorMessage(err)}`);
      return outcome;
    }
    if (verdict.ok) return outcome;
    const reason = verdict.reason.trim() || "the scan output did not pass the source's checks";
    return verdict.adapterBroken
      ? { kind: "failed", error: adapterBrokenError(reason, verdict.screenshot), output: outcome.output, retryable: false, safety: outcome.safety }
      : { kind: "failed", error: scanRejectedError(reason), output: outcome.output, retryable: true, safety: outcome.safety };
  }

  private checkInjectionReport(task: Task, outcome: Outcome): Outcome {
    if (outcome.kind !== "ok" && outcome.kind !== "paused") return outcome;
    const key = taskKey(task.botName, task.kind);
    const report = reportedInjection(key, outcome.output);
    if (!report) return outcome;
    const detail = injectionDetail(report.note);
    const safety: SafetyNote[] = [...(outcome.safety ?? []), { reason: "injection_flagged", action: key, detail, demote: false }];
    if (key === "apply.submit" && outcome.kind === "paused") {
      return { kind: "failed", error: `Apply reported a suspected injection: ${detail}`, output: outcome.output, retryable: false, safety };
    }
    return { ...outcome, safety };
  }

  /**
   * PM2 S10 (decision 10c): the site guard checks `navigate` before it runs, but a click can take
   * the tab elsewhere. After the run, Apply's finalUrl and every page URL the Chrome tools reported
   * must be on the approval's domains (with any Ba confirmed). Otherwise: safety.denied
   * (off_allowlist) and needs_check — a finished Apply is never recorded clean, a paused one stops.
   * Logged, not a demotion: the guard did not block anything the bot asked for.
   */
  private checkApplyPages(task: Task, outcome: Outcome, result: RunnerResult): Outcome {
    if (outcome.kind === "cancelled" || outcome.kind === "needs_figma") return outcome;
    const input = (task.input ?? {}) as { applicationId?: unknown; allowedDomains?: unknown };
    const approval = latestApprovalForApplication(this.core.db, Number(input.applicationId));
    const fromInput = Array.isArray(input.allowedDomains) ? input.allowedDomains.filter((d): d is string => typeof d === "string") : [];
    const sites = approval?.allowedDomains ?? fromInput;
    const output = "output" in outcome ? (outcome.output as Partial<ApplyOutput> | null | undefined) : undefined;
    const urls = [...(result.pageUrls ?? []), ...(typeof output?.finalUrl === "string" ? [output.finalUrl] : [])];
    const off = urls.filter((url) => !evaluateChromeToolCall({ toolName: `${CHROME_TOOL_PREFIX}navigate`, toolInput: { url } }, { allowedSites: sites }).allow);
    if (off.length === 0) return outcome;
    const hosts = [...new Set(off.map((u) => hostOfUrl(u) ?? u))];
    const detail = `Apply's tab reached ${hosts.join(", ")}, outside the approved domains (${sites.join(", ") || "none"})`;
    const safety: SafetyNote[] = [...(outcome.safety ?? []), { reason: "off_allowlist", action: "apply.page_check", detail, demote: false }];
    if (outcome.kind === "ok") return { ...outcome, safety, recordCheck: detail };
    if (outcome.kind === "paused") return { kind: "failed", error: detail, output: outcome.output, retryable: false, safety };
    return { ...outcome, safety };
  }

  /** PM2 S7: the attempt's captures: the folder's manifest (every spawn of the attempt), else what this spawn listed. */
  private async capturesOf(dir: string, result: RunnerResult): Promise<CapturedScreenshot[]> {
    const fromDisk = readScreenshotManifest(await this.core.deps.files.readText(join(dir, SCREENSHOT_MANIFEST)).catch(() => null));
    return fromDisk.length > 0 ? fromDisk : [...(result.screenshots ?? [])];
  }

  classify(task: Task, bot: EffectiveBot, result: RunnerResult): Outcome {
    const key = taskKey(task.botName, task.kind);
    switch (result.status) {
      case "ok": {
        let schema;
        try {
          schema = resolveOutputSchemaName(bot.def, task.kind);
        } catch (err) {
          return { kind: "failed", error: errorMessage(err), retryable: false };
        }
        // Validate at the boundary even though the runner did (PM brief).
        const parsed = parseBotOutput(schema, result.output);
        if (!parsed.success) {
          const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
          return { kind: "failed", error: `invalid output: ${issues.join("; ")}`, retryable: true };
        }
        const output = parsed.data as { selfCheck: { item: string; passed: boolean; note: string | null }[] };
        // Rule 4: any failed self-check item fails the attempt.
        const failed = failedSelfChecks(output.selfCheck).map((i) => i.item);
        if (failed.length > 0) {
          return { kind: "failed", error: `self-check failed: ${failed.join("; ")}`, output, retryable: true, safety: pageMismatch(key, failed) };
        }
        const pause = this.selfPause(task, output);
        return pause ? { kind: "paused", reason: pause, output } : { kind: "ok", output };
      }
      case "self_check_failed":
        return {
          kind: "failed",
          error: `self-check failed: ${result.failed.join("; ")}`,
          output: result.output,
          retryable: true,
          safety: pageMismatch(key, result.failed),
        };
      case "invalid_output":
        return { kind: "failed", error: `invalid output after the repair prompt: ${result.errors.slice(0, 3).join("; ")}`, retryable: true };
      case "failed":
        return { kind: "failed", error: result.error, retryable: true };
      case "timeout":
        return { kind: "failed", error: "timed out", retryable: true };
      case "denied": {
        const safety = result.denials.map(denialNote);
        // Live run 1 (F5): only Figma-guard blocks on a Figma task. The block prevented the call;
        // the bot's output decides the attempt, and afterFigmaTask's fingerprint check decides
        // whether the block was harmless (informational) or a protected page changed (fail + demote).
        if (task.usesFigma && result.denials.every(isFigmaGuardDenial)) {
          if (result.output === null) {
            const tools = [...new Set(result.denials.map((d) => d.tool))].join(", ");
            return { kind: "failed", error: `the Figma guard blocked ${tools} and the bot returned no valid output`, retryable: true, safety };
          }
          const fromOutput = this.classify(task, bot, { status: "ok", output: result.output, sessionId: null, durationMs: result.durationMs });
          return { ...fromOutput, safety: [...(fromOutput.safety ?? []), ...safety] } as Outcome;
        }
        // UC-11 e: the site guard stopped Apply at a domain outside the approval and Apply paused for Ba.
        if (key === "apply.submit" && result.output !== null) {
          const parsed = parseBotOutput("ApplyOutput", result.output);
          if (parsed.success && parsed.data.status === "paused" && parsed.data.pauseReason?.reason === "domain_confirm") {
            const pause = this.selfPause(task, parsed.data);
            if (pause) return { kind: "paused", reason: pause, output: parsed.data, safety };
          }
        }
        return {
          kind: "failed",
          error: `denied: ${result.denials.map((d) => d.tool).join(", ")}`,
          ...(result.output !== null ? { output: result.output } : {}),
          retryable: true,
          safety,
        };
      }
      case "usage_limit":
        return { kind: "usage_limit", engine: result.engine, resetsAt: result.resetsAt };
      case "cancelled":
        return { kind: "cancelled" };
    }
  }

  /** The guard hooks' blocks in this attempt (empty when there is no log or it cannot be read). */
  private async readGuardLog(prepared: Prepared): Promise<GuardBlock[]> {
    if (!prepared.guardLog) return [];
    const text = await this.core.deps.files.readText(prepared.guardLog).catch(() => null);
    return parseGuardLog(text === null ? null : text.slice(prepared.guardLogOffset));
  }

  /**
   * Coordinator E: every block the guard hooks logged becomes a safety.denied event (a blocked
   * call does not end the bot's session by itself). The log has the same blocks as the runner's
   * hook denials, so those are kept only when the log is empty or unreadable.
   */
  private withGuardLog(outcome: Outcome, blocks: readonly GuardBlock[]): Outcome {
    if (blocks.length === 0) return outcome;
    const own = (outcome.safety ?? []).filter((s) => !s.fromHook);
    return { ...outcome, safety: [...own, ...blocks.map(blockNote)] } as Outcome;
  }

  /** The orchestrator's own Figma call; Figma going away becomes FigmaGone. */
  private async figmaCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (isFigmaUnavailable(err)) throw new FigmaGone(errorMessage(err));
      throw err;
    }
  }

  /**
   * §6.2 after a CV task, still under the Figma lock: the protected pages must be unchanged
   * (any change fails the task and alerts Ba). When they are, a Figma-guard block was prevention
   * that worked: it stays a safety event (figma_guard_blocked) but neither fails nor demotes. Then the orchestrator finds the bot's Drafts frame,
   * exports it (one A4 page), and extracts its text for QA.
   */
  private async afterFigmaTask(task: Task, prepared: Prepared, outcome: Outcome): Promise<{ outcome: Outcome; exported?: CvExport }> {
    const core = this.core;
    const before = prepared.figmaBefore;
    const keep = (o: Outcome): Outcome => ({ ...o, ...(outcome.safety ? { safety: [...(o.safety ?? []), ...outcome.safety] } : {}) }) as Outcome;
    try {
      if (before) {
        // A figma_execute that timed out may still have finished inside Figma: always re-check.
        const after = await this.figmaCall(() => core.deps.figma.fingerprintProtectedPages());
        const diff = diffFingerprints(before, after);
        if (!diff.changed) outcome = figmaBlocksVerified(outcome);
        if (diff.changed) {
          return {
            outcome: keep({
              kind: "failed",
              error: `${diff.summary} Restore them from Figma's version history (§6.2).`,
              retryable: false,
              safety: [{ reason: "protected_page_changed", action: "figma_execute", detail: diff.summary }],
            }),
          };
        }
      }
      if (outcome.kind !== "ok" || taskKey(task.botName, task.kind) !== "cv.tailor") return { outcome };
      const output = outcome.output as CvOutput;
      const expected = (task.input as { language?: string } | null)?.language;
      if (expected && output.language !== expected) {
        return { outcome: keep({ kind: "failed", error: `the CV is in ${output.language}, the task asked for ${expected}`, output, retryable: true }) };
      }
      const frame = await this.figmaCall(() => core.deps.figma.findDraftFrame(output.figmaFrameName));
      if (!frame) {
        return { outcome: keep({ kind: "failed", error: `the CV frame ${output.figmaFrameName} is not on the Drafts page`, output, retryable: true }) };
      }
      const pdfPath = this.uniquePdfPath(pdfFileNameForFrame(output.figmaFrameName));
      const exp = await this.figmaCall(() => core.deps.figma.exportFramePdf(frame.id, core.paths.abs(pdfPath)));
      if (!exp.onePageA4) {
        return {
          outcome: keep({ kind: "failed", error: `the exported PDF is not one A4 portrait page (${exp.pageCount} page(s))`, output, retryable: true }),
        };
      }
      const pdfText = await core.deps.pdf.extractText(core.paths.abs(pdfPath)).catch(() => "");
      const pdf = { pageCount: exp.pageCount, onePageA4: exp.onePageA4, widthPt: exp.widthPt ?? null, heightPt: exp.heightPt ?? null, sha256: exp.sha256, textChars: pdfText.length };
      return { outcome, exported: { pdfPath, sha256: exp.sha256, pdfText, pdf, figmaFrameUrl: frame.url } };
    } catch (err) {
      if (err instanceof FigmaGone) {
        return { outcome: keep({ kind: "needs_figma", detail: `Figma went away after the CV task: ${err.message}`, beforeHash: before?.hash ?? null }) };
      }
      return { outcome: keep({ kind: "failed", error: `PDF export failed: ${errorMessage(err)}`, retryable: true }) };
    }
  }

  /** data/pdf/<name>.pdf, or a numbered name when another CV version already uses it (never overwrite an approved PDF). */
  private uniquePdfPath(fileName: string): string {
    const base = `pdf/${fileName}`;
    if (!findCvVersionByPdfPath(this.core.db, base)) return base;
    for (let n = 2; ; n++) {
      const candidate = base.replace(/\.pdf$/, `-${n}.pdf`);
      if (!findCvVersionByPdfPath(this.core.db, candidate)) return candidate;
    }
  }

  private settle(task: Task, prepared: Prepared, outcome: Outcome, exported: CvExport | undefined): void {
    const core = this.core;
    const key = taskKey(task.botName, task.kind);
    const retryable = isRetryableTask(task.botName, task.kind);
    core.db.transaction((tx) => {
      const current = getTask(tx, task.id);
      for (const s of outcome.safety ?? []) {
        emitSafetyDenied(core, tx, { botName: task.botName, taskId: task.id, action: s.action, reason: s.reason, detail: s.detail });
        // PM2 S11: Apply met an injection on the job's page: the job is flagged like QA's flag.
        if (s.reason === "injection_flagged" && key === "apply.submit") flagApplyJob(tx, task);
      }
      // PM2 S8: a violation by the bot's own conduct demotes it one level (once per task).
      const violation = (outcome.safety ?? []).find(
        (s) =>
          s.demote !== false &&
          DEMOTING_SAFETY_REASONS.includes(s.reason) &&
          !(outcome.kind === "paused" && outcome.reason.code === "domain_confirm" && s.reason === "off_allowlist"),
      );
      const changed = (outcome.safety ?? []).find((s) => s.reason === "protected_page_changed");
      if (changed) {
        // §6.2: any change to a protected page alerts Ba; it may have been his own edit (S8).
        const demoted = demoteBot(core, tx, { botName: task.botName, reason: "protected_page_changed", detail: changed.detail, taskId: task.id, runId: task.runId, silent: true });
        postProtectedChangeAlert(core, tx, task, `A protected Figma page changed during a CV task, by the bot or by you, so I stopped it. ${changed.detail ?? ""}`, demoted);
      } else if (violation) {
        demoteBot(core, tx, { botName: task.botName, reason: violation.reason, detail: violation.detail, taskId: task.id, runId: task.runId });
      }
      if (!current || current.status !== "running") {
        // Finished elsewhere while it ran (the run was cancelled). An Apply that ran may have submitted.
        if (!retryable && prepared.apply) onApplyFailedAfterSpawn(core, tx, current ?? task, "cancelled while it ran");
        return;
      }
      if (outcome.kind !== "ok" && task.runId !== null && getRun(tx, task.runId)?.status === "cancelled") {
        // Ba cancelled the run as the CLI exited: a pause, a retry or a wait would never be
        // claimed again, so the task ends now. A clean result is still kept (Apply may have
        // submitted), and a usage limit still pauses its engine.
        if (outcome.kind === "usage_limit") core.pauseEngineForLimit(tx, outcome.engine, outcome.resetsAt);
        failTaskNow(core, tx, task, "cancelled");
        if (!retryable && prepared.apply) onApplyFailedAfterSpawn(core, tx, task, "cancelled while it ran");
        return;
      }
      switch (outcome.kind) {
        case "ok": {
          const done = completeTask(tx, task.id, { output: outcome.output, now: core.now() });
          emitTaskFinished(core, tx, done, "done", null);
          const ctx = task.runId === null ? null : loadRunCtx(core, task.runId, tx);
          this.onDone(tx, ctx, done, outcome.output, exported, outcome.recordFiles, outcome.recordCheck);
          return;
        }
        case "paused": {
          const paused = pauseTask(tx, task.id, outcome.reason, { output: outcome.output });
          emitTaskPaused(core, tx, paused, outcome.reason);
          // S1: the UC-17 card (login, CAPTCHA, a domain to confirm); questions get their own cards.
          noticePause(core, tx, paused, outcome.reason);
          if (key === "apply.submit") onApplyPaused(core, tx, paused, outcome.output as ApplyOutput);
          return;
        }
        case "needs_figma":
          // No attempt is used up; the next spawn checks the pages against this "before" hash.
          core.waitForBridge(tx, current, "needs_figma", { detail: outcome.detail, output: { figmaBeforeHash: outcome.beforeHash } });
          return;
        case "failed":
          if (outcome.limit) core.pauseEngineForLimit(tx, outcome.limit.engine, outcome.limit.resetsAt);
          this.failAttempt(tx, task, outcome.error, outcome.output, outcome.retryable && retryable, prepared.apply);
          return;
        case "usage_limit": {
          core.pauseEngineForLimit(tx, outcome.engine, outcome.resetsAt);
          if (!retryable) {
            const error = "the usage limit was hit while Apply ran";
            failTaskNow(core, tx, task, error);
            if (prepared.apply) onApplyFailedAfterSpawn(core, tx, task, error);
            return;
          }
          // UC-16 step 5: the task restarts from its beginning after the reset, as the same attempt.
          const queued = requeueTask(tx, task.id);
          holdEngineTasks(tx, outcome.engine);
          emitTaskPaused(core, tx, queued, { code: "usage_limit", site: null, detail: outcome.resetsAt ? `until ${outcome.resetsAt}` : null });
          return;
        }
        case "cancelled":
          failTaskNow(core, tx, task, "cancelled");
          if (!retryable && prepared.apply) onApplyFailedAfterSpawn(core, tx, task, "cancelled while it ran");
          return;
      }
    });
    if (outcome.kind === "ok") this.appendMemory(task, outcome.output);
  }

  /** §5.5 step 6: a failed attempt is retried once; apply.submit never (it may have submitted). */
  private failAttempt(tx: Conn, task: Task, error: string, output: unknown, retry: boolean, spawnedApply: boolean): void {
    const core = this.core;
    if (!isRetryableTask(task.botName, task.kind)) {
      failTaskNow(core, tx, task, error, output);
      if (spawnedApply) onApplyFailedAfterSpawn(core, tx, task, error);
      return;
    }
    if (retry && task.attempt < core.config.maxAttempts) {
      emitTaskFinished(core, tx, task, "failed", error);
      requeueTask(tx, task.id, { newAttempt: true });
      return;
    }
    const failed = failTaskNow(core, tx, task, error, output);
    // §5.5 step 6: the task failed for good, so Lead reports it (S1); never for a retried attempt.
    // A conversation's failure goes to W3a's sink instead (S2).
    noticeTaskFailed(core, tx, failed, error);
    sinkFailed(core, tx, failed, error);
  }

  private onDone(tx: Conn, ctx: RunCtx | null, task: Task, output: unknown, exported: CvExport | undefined, recordFiles?: RecordFiles, recordCheck?: string): void {
    const core = this.core;
    const input = (task.input ?? {}) as Record<string, unknown>;
    switch (taskKey(task.botName, task.kind)) {
      case "research.fit":
        setJobFit(tx, Number(input.jobId), (output as ResearchFitOutput).fit);
        return;
      case "research.company": {
        const company = ensureCompany(tx, { name: String(input.name) });
        saveCompanyProfile(tx, company.id, { profile: (output as ResearchCompanyOutput).company }, { now: core.now() });
        return;
      }
      case "cv.tailor":
        if (ctx && exported) onProducerDone(core, tx, ctx, task, output as CvOutput, exported);
        return;
      case "qa.review":
        if (ctx) onCheckerDone(core, tx, ctx, task, output as QaOutput);
        return;
      case "cv.fact_draft":
        // Owner request 2026-10-11: the invented-detail guard, then the API adds the facts.
        onFactDraftDone(core, tx, task, output as FactDraftOutput);
        return;
      case "apply.submit":
        onApplyDone(core, tx, task, output as ApplyOutput, recordFiles, recordCheck ?? null);
        announceSettledDryRun(core, tx, task.stepId === null ? undefined : getStep(tx, task.stepId));
        return;
      default:
        // PM2 S2: W3a posts the reply (and queues Lead's chat for a handoff) in this transaction.
        if (isConversationTask(task) && core.deps.conversations) {
          const result = (task.kind === "chat" ? { kind: "chat", output } : { kind: task.kind, output }) as Parameters<typeof core.deps.conversations.done>[1];
          core.deps.conversations.done(sinkContext(core, tx, task), result);
        }
        return;
    }
  }

  // ------------------------------------------------------------------ before the spawn

  /** The trust guard refused (nothing ran): the task fails with a safety.denied event. */
  private refuse(task: Task, reason: SafetyDenialReason, detail: string): void {
    this.core.db.transaction((tx) => {
      const failed = failTaskNow(this.core, tx, task, `denied: ${detail}`);
      emitSafetyDenied(this.core, tx, { botName: task.botName, taskId: task.id, action: taskKey(task.botName, task.kind), reason, detail });
      if (reason === "protected_page_changed") {
        // PM2 S8: the change happened after an earlier spawn of this task, by the bot or by Ba.
        const demoted = demoteBot(this.core, tx, { botName: task.botName, reason, detail, taskId: task.id, runId: task.runId, silent: true });
        postProtectedChangeAlert(this.core, tx, task, `I stopped a CV task: ${detail}, by the bot or by you.`, demoted);
      }
      else if (isRetryableTask(task.botName, task.kind)) noticeTaskFailed(this.core, tx, failed, `denied: ${detail}`);
      sinkFailed(this.core, tx, failed, `denied: ${detail}`);
      if (!isRetryableTask(task.botName, task.kind)) applyStoppedBeforeSpawn(this.core, tx, task, "denied", detail);
    });
  }

  private failBeforeSpawn(task: Task, error: string): void {
    this.core.db.transaction((tx) => this.failAttempt(tx, task, error, undefined, true, false));
  }

  private waitBridge(task: Task, reason: "needs_browser" | "needs_figma", opts: { detail?: string } = {}): void {
    this.core.db.transaction((tx) => {
      const current = getTask(tx, task.id);
      if (current?.status === "running") this.core.waitForBridge(tx, current, reason, opts);
    });
  }

  private crash(task: Task, entry: Inflight, err: unknown): void {
    const core = this.core;
    core.log.error(`engine error in task ${task.id} (${task.botName}.${task.kind}): ${errorMessage(err)}`);
    try {
      core.db.transaction((tx) => {
        const current = getTask(tx, task.id);
        if (current?.status !== "running") return;
        const error = `engine error: ${errorMessage(err)}`;
        const failed = failTaskNow(core, tx, current, error);
        sinkFailed(core, tx, failed, error);
        if (isRetryableTask(task.botName, task.kind)) noticeTaskFailed(core, tx, failed, error);
        else {
          // After the spawn it may have submitted; before it, nothing ran and the token is untouched.
          if (entry.spawned) onApplyFailedAfterSpawn(core, tx, current, error);
          else applyStoppedBeforeSpawn(core, tx, current, "not_started", error);
        }
      });
    } catch (inner) {
      core.log.error(`could not record the engine error for task ${task.id}: ${errorMessage(inner)}`);
    }
  }

  private appendMemory(task: Task, output: unknown): void {
    const notes = (output as { memoryNotes?: string[] } | null)?.memoryNotes ?? [];
    const writer = this.core.deps.memory;
    if (!writer || notes.length === 0) return;
    // PM2 S14: a note may name only the hosts this task could open.
    const browser = this.core.deps.bots.get(task.botName)?.browser;
    const domains = (task.input as { allowedDomains?: unknown } | null)?.allowedDomains;
    const allowedSites = browser?.sitesFromApproval
      ? Array.isArray(domains) ? domains.filter((d): d is string => typeof d === "string") : []
      : [...(browser?.allowedSites ?? [])];
    writer.append({ botName: task.botName, notes, runId: task.runId, taskId: task.id, allowedSites }).catch((err: unknown) => {
      this.core.log.warn(`memory notes of task ${task.id} were not saved: ${errorMessage(err)}`);
    });
  }
}
