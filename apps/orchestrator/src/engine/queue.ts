// The task queue (§4.2, §5.5, §10): claims runnable tasks within the per-engine caps, the browser
// lock and the Figma lock (§10.3), checks each one before it spawns (trust guard, Chrome / Figma
// bridge, read folders, Apply's token and file, guard hooks), runs it, and settles the result
// with the attempt policy: 2 attempts per task (§5.5 step 6), never for apply.submit once it
// started (PM FYI c). Locks live in memory; they are free after a restart because recovery runs
// first. The Figma lock covers the orchestrator's own fingerprint and export calls too.
import { basename, join } from "node:path";
import {
  EngineSchema,
  PauseReasonSchema,
  failedSelfChecks,
  isRetryableTask,
  parseBotOutput,
  resolveOutputSchemaName,
  taskKey,
  type ApplyOutput,
  type CvOutput,
  type Engine,
  type PauseReason,
  type QaOutput,
  type ResearchCompanyOutput,
  type ResearchFitOutput,
  type SafetyDenialReason,
} from "@bs-job-agents/shared";
import { isFigmaUnavailable } from "../bridges/figma/errors.js";
import { diffFingerprints, templatesFromFingerprint, type ProtectedPagesFingerprint } from "../bridges/figma/fingerprint.js";
import { mergeHookSettings, type ClaudeHookSettings } from "../bridges/hooks/settings.js";
import { pdfFileNameForFrame } from "../bridges/pdf/files.js";
import {
  claimNextTask,
  completeTask,
  ensureCompany,
  findCvVersionByPdfPath,
  getTask,
  holdEngineTasks,
  pauseTask,
  requeueTask,
  saveCompanyProfile,
  setJobFit,
  setTaskTranscriptPath,
  updateTaskInput,
  type Conn,
  type Task,
} from "../db/index.js";
import type { PermissionDenial, RunnerEvent, RunnerResult, RunnerTask } from "../runner/types.js";
import { onApplyDone, onApplyFailedAfterSpawn, onApplyPaused, prepareApply, registrableHost } from "./apply.js";
import { MASTER_CV_TASK_KEYS, effectiveBot, type EffectiveBot } from "./bots.js";
import { loadRunCtx, type RunCtx } from "./context.js";
import type { EngineCore } from "./core.js";
import { errorMessage } from "./errors.js";
import { onCheckerDone, onProducerDone, type CvExport } from "./gate.js";
import type { GuardBlock } from "./ports.js";
import { emitSafetyDenied, emitTaskFinished, emitTaskPaused, failTaskNow, postLeadMessage, stillRunning } from "./task-events.js";
import { checkTaskTrust } from "./trust-guard.js";

const ENGINES = EngineSchema.options;

interface SafetyNote {
  reason: SafetyDenialReason;
  action: string;
  detail: string | null;
  /** A runner denial from a guard hook (the guard log has the same block). */
  fromHook?: boolean;
}

/** What one attempt came to, after the engine checked the runner's result. */
export type Outcome =
  | { kind: "ok"; output: unknown; safety?: SafetyNote[] }
  /** The bot paused itself: a login, a CAPTCHA, questions, a domain to confirm (UC-03 a, UC-11, UC-12, UC-17). */
  | { kind: "paused"; reason: PauseReason; output: unknown; safety?: SafetyNote[] }
  | { kind: "failed"; error: string; output?: unknown; retryable: boolean; safety?: SafetyNote[] }
  | { kind: "usage_limit"; engine: Engine; resetsAt: string | null; safety?: SafetyNote[] }
  | { kind: "cancelled"; safety?: SafetyNote[] }
  /** Figma went away during the orchestrator's own calls: wait as needs_figma, then run again. */
  | { kind: "needs_figma"; detail: string; beforeHash: string | null; safety?: SafetyNote[] };

interface Prepared {
  runnerTask: RunnerTask;
  bot: EffectiveBot;
  /** CV tasks: the protected pages before the bot ran. */
  figmaBefore?: ProtectedPagesFingerprint;
  /** apply.submit passed the trust guard (a token was consumed or re-validated). */
  apply: boolean;
  /** Absolute JSONL log the guard hooks write their decisions to. */
  guardLog: string | null;
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

  constructor(private readonly core: EngineCore) {}

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
    const entry = this.inflight.get(taskId);
    if (!entry) return false;
    entry.controller.abort();
    return true;
  }

  /** Claim and start everything runnable now (sync). */
  dispatch(): void {
    if (this.stopped) return;
    for (;;) {
      const engines = ENGINES.filter((e) => this.running(e) < this.core.config.engineCaps[e]);
      if (engines.length === 0) return;
      const task = claimNextTask(this.core.db, {
        engines,
        allowBrowser: this.browserLock === null,
        allowFigma: this.figmaLock === null,
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
      const pending = [...this.inflight.values()].map((e) => e.promise);
      if (pending.length > 0) {
        await Promise.all(pending);
        continue;
      }
      await new Promise((resolve) => setImmediate(resolve));
      if (this.inflight.size === 0) return;
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
        this.core.advance(task.runId);
        this.dispatch();
        this.core.bus.flush();
      });
  }

  // ------------------------------------------------------------------ one attempt

  private async execute(task: Task, entry: Inflight): Promise<void> {
    const core = this.core;
    const prepared = await this.prepare(task, entry.controller);
    if (!prepared) return;
    const { runnerTask, bot } = prepared;
    core.db.transaction((tx) => {
      setTaskTranscriptPath(tx, task.id, core.paths.transcript(task.id, task.attempt));
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
    outcome = await this.withGuardLog(prepared, outcome);
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
      bot = effectiveBot(core.db, core.deps.bots, task.botName);
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
        const file = input as { path: string; filename: string };
        const dest = join(taskDir, basename(file.filename));
        await core.deps.files.copy(core.paths.abs(file.path), dest);
        input = { ...file, path: dest };
        readDirs = [taskDir];
        core.db.transaction((tx) => updateTaskInput(tx, task.id, input));
      }
    } catch (err) {
      this.failBeforeSpawn(task, `could not prepare the task's read folder: ${errorMessage(err)}`);
      return null;
    }
    if (trust.needsApproval) {
      const prep = await prepareApply(core, task);
      if (prep.kind === "stopped") return null;
      input = prep.input;
      readDirs = [prep.readDir];
      allowedSites = prep.allowedSites;
    } else if (bot.def.browser && !bot.def.browser.sitesFromApproval) {
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
        const verified = (task.output as { figmaBeforeHash?: string } | null)?.figmaBeforeHash;
        if (verified && verified !== figmaBefore.hash) {
          // An earlier spawn's after-check never ran (Figma went away): what changed since is unverified.
          this.refuse(task, "protected_page_changed", "the protected Figma pages changed while this CV task waited for Figma; check them before continuing");
          return null;
        }
        if (key === "cv.tailor") {
          input = { ...(input as Record<string, unknown>), templates: templatesFromFingerprint(figmaBefore) };
          core.db.transaction((tx) => updateTaskInput(tx, task.id, input));
        }
        if (claude) hooks.push(await core.deps.guards.figmaGuard({ fingerprint: figmaBefore, dir: taskDir, logFile: guardLog!, draftsPageId: drafts.id }));
      } catch (err) {
        if (isFigmaUnavailable(err)) this.waitBridge(task, "needs_figma", { detail: `Figma went away: ${errorMessage(err)}` });
        else this.failBeforeSpawn(task, `Figma: ${errorMessage(err)}`);
        return null;
      }
    }
    if (!stillRunning(core.db, task.id)) return null;
    return {
      bot,
      apply: trust.needsApproval,
      guardLog,
      ...(figmaBefore ? { figmaBefore } : {}),
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
        ...(hooks.length > 0 ? { hookSettings: mergeHookSettings(...hooks) as unknown as Record<string, unknown> } : {}),
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

  /** What a bot reported as its own pause (UC-03 a, UC-11 a/b/e, UC-12, UC-17). */
  private selfPause(task: Task, output: unknown): PauseReason | null {
    const key = taskKey(task.botName, task.kind);
    if (key === "research.scan" || key === "research.single" || key === "research.file") {
      const blocked = (output as { blocked?: { reason: "needs_login" | "captcha"; site: string; detail: string | null } | null }).blocked;
      return blocked ? { code: blocked.reason, site: blocked.site, detail: blocked.detail } : null;
    }
    if (key === "apply.submit") {
      const o = output as ApplyOutput;
      if (o.status !== "paused") return null;
      const code = o.pauseReason?.reason ?? "needs_answer";
      let site = o.pauseReason?.site ?? null;
      if (!site && code !== "needs_answer") {
        const url = (task.input as { jobUrl?: string } | null)?.jobUrl;
        site = url ? registrableHost(url) : null;
      }
      const reason = { code, site, detail: o.pauseReason?.detail ?? null };
      return PauseReasonSchema.safeParse(reason).success ? reason : { code: "needs_answer", site: null, detail: reason.detail };
    }
    return null;
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

  /**
   * Coordinator E: every block the guard hooks logged becomes a safety.denied event (a blocked
   * call does not end the bot's session). The log has the same blocks as the runner's hook
   * denials, so those are kept only when the log is empty or unreadable.
   */
  private async withGuardLog(prepared: Prepared, outcome: Outcome): Promise<Outcome> {
    if (!prepared.guardLog) return outcome;
    const blocks = parseGuardLog(await this.core.deps.files.readText(prepared.guardLog).catch(() => null));
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
   * (any change fails the task and alerts Ba); then the orchestrator finds the bot's Drafts frame,
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
      return { outcome, exported: { pdfPath, sha256: exp.sha256, pdfText, figmaFrameUrl: frame.url } };
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
        if (s.reason === "protected_page_changed") {
          // §6.2: any change to a protected page alerts Ba; Figma's version history can restore it.
          postLeadMessage(core, tx, `A protected Figma page changed during a CV task, so I stopped it. ${s.detail ?? ""} Please check the file and restore the page from Figma's version history.`.trim(), {
            runId: task.runId,
          });
        }
      }
      if (!current || current.status !== "running") {
        // Finished elsewhere while it ran (the run was cancelled). An Apply that ran may have submitted.
        if (!retryable && prepared.apply) onApplyFailedAfterSpawn(core, tx, current ?? task, "cancelled while it ran");
        return;
      }
      switch (outcome.kind) {
        case "ok": {
          const done = completeTask(tx, task.id, { output: outcome.output, now: core.now() });
          emitTaskFinished(core, tx, done, "done", null);
          const ctx = task.runId === null ? null : loadRunCtx(core, task.runId, tx);
          this.onDone(tx, ctx, done, outcome.output, exported);
          return;
        }
        case "paused": {
          const paused = pauseTask(tx, task.id, outcome.reason, { output: outcome.output });
          emitTaskPaused(core, tx, paused, outcome.reason);
          if (key === "apply.submit") onApplyPaused(core, tx, paused, outcome.output as ApplyOutput);
          return;
        }
        case "needs_figma":
          // No attempt is used up; the next spawn checks the pages against this "before" hash.
          core.waitForBridge(tx, current, "needs_figma", { detail: outcome.detail, output: { figmaBeforeHash: outcome.beforeHash } });
          return;
        case "failed":
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
    failTaskNow(core, tx, task, error, output);
  }

  private onDone(tx: Conn, ctx: RunCtx | null, task: Task, output: unknown, exported: CvExport | undefined): void {
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
      case "apply.submit":
        onApplyDone(core, tx, task, output as ApplyOutput);
        return;
      default:
        return;
    }
  }

  // ------------------------------------------------------------------ before the spawn

  /** The trust guard refused (nothing ran): the task fails with a safety.denied event. */
  private refuse(task: Task, reason: SafetyDenialReason, detail: string): void {
    this.core.db.transaction((tx) => {
      failTaskNow(this.core, tx, task, `denied: ${detail}`);
      emitSafetyDenied(this.core, tx, { botName: task.botName, taskId: task.id, action: taskKey(task.botName, task.kind), reason, detail });
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
        failTaskNow(core, tx, current, error);
        if (entry.spawned && !isRetryableTask(task.botName, task.kind)) onApplyFailedAfterSpawn(core, tx, current, error);
      });
    } catch (inner) {
      core.log.error(`could not record the engine error for task ${task.id}: ${errorMessage(inner)}`);
    }
  }

  private appendMemory(task: Task, output: unknown): void {
    const notes = (output as { memoryNotes?: string[] } | null)?.memoryNotes ?? [];
    const writer = this.core.deps.memory;
    if (!writer || notes.length === 0) return;
    writer.append({ botName: task.botName, notes, runId: task.runId, taskId: task.id }).catch((err: unknown) => {
      this.core.log.warn(`memory notes of task ${task.id} were not saved: ${errorMessage(err)}`);
    });
  }
}
