// Skill self-repair (sub-project 4 §5.1–§5.7, AD-7): a source skill that no longer matches its board
// is redrafted, screened, validated with a real scan and adopted, with no file edited by Ba.
//
//   trigger    a research.scan on the browser path fails for good as "adapter broken: …" (never a
//              transient failure, a block, an API-path failure or a repair's own scan). One active
//              repair per source (a unique partial index), at most 2 automatic attempts per source in
//              24 hours, one repair at a time overall (later ones wait as "queued": Chrome is shared),
//              none while the source is paused after 3 attempts in a row were not adopted.
//   draft      a research.repair task (no run; the scan's Chrome read tools and site guard, its skill
//              reads, nothing else) returns the whole new skill and the changes it cannot make. The
//              draft lives in the skill_repairs row, never on disk.
//   screen     screenSkillDraft (shared, the rule set CI runs over every committed skill).
//   validate   a research.scan of the source with the failed scan's criteria, no run, and
//              skillOverride: the runner puts the draft in the prompt. Adopted only when the
//              orchestrator's own checks pass (schema, self-check, the ScanOutputChecker), nothing
//              blocked it and at least 1 job came back (SEC-11). Its jobs are discarded.
//   adopt      the activity event with the text in force before and the new text is committed
//              first, then SkillFiles.write replaces the one file (SEC-14); a failed write is logged
//              as not adopted and the file stays as it was. Changes outside the skill are listed as
//              "not applied" and never made (REQ-13).
//   notices    "Automatic repair failed: <reason>" after the scan's "<Source> adapter broken" line;
//              "Automatic repair worked" on adoption; a paused source says so on its next failure.
//   restore    the latest adopted repair of a source can be undone while the file still holds its text.
//
// The app never commits to git: an adopted skill stays an uncommitted change in the working tree.
import {
  ResearchScanInputSchema,
  screenSkillDraft,
  taskKey,
  type ResearchRepairInput,
  type ResearchRepairOutput,
  type ResearchScanOutput,
  type SkillRepairActivityEntry,
  type SourceApiActivityEntry,
} from "@bs-job-agents/shared";
import { skillHosts, skillScreenContext, isSkillSource } from "../adapters/skill-screen.js";
import { SOURCE_ADAPTERS, scanJobLimit, searchUrls } from "../adapters/sources.js";
import {
  countSkillRepairsSince,
  createTask,
  getSkillRepair,
  getSkillRepairSource,
  getTask,
  holdEngineTasks,
  insertSkillRepair,
  isEnginePaused,
  listActiveSkillRepairs,
  listEvents,
  listSkillRepairs,
  setSkillRepairSource,
  updateSkillRepair,
  type Conn,
  type Db,
  type SkillRepair,
  type Task,
} from "../db/index.js";
import { effectiveBot, taskNeeds } from "./bots.js";
import type { EngineCore } from "./core.js";
import { errorMessage } from "./errors.js";
import { postNotice, sourceLabel } from "./notices.js";
import type { SkillFiles } from "./ports.js";

export const REPAIR_BOT = "research";
export const REPAIR_KIND = "repair";
/** Automatic attempts per source in 24 hours (Ba's "Try repair again" does not count). */
export const SKILL_REPAIR_DAILY_CAP = 2;
/** Consecutive attempts not adopted before automatic repair of a source pauses (SEC-13). */
export const SKILL_REPAIR_PAUSE_AFTER = 3;
const DAY_MS = 24 * 3600_000;

const ADAPTER_BROKEN = /^adapter broken: /;
const SCREENSHOT = /\s*\(screenshot: ([^)]*)\)\s*$/;
const LAYOUT_NOTE = /`(Layout changed: [^`]+)`/;
const NO_RESULTS_NOTE = /`(No results: [^`]+)`/;

type Ended = { kind: "adopted" } | { kind: "not_adopted"; reason: string };

/** research.repair, or a research.scan that validates a drafted skill. */
export function isSkillRepairTask(task: Pick<Task, "botName" | "kind" | "input">): boolean {
  return task.botName === REPAIR_BOT && (task.kind === REPAIR_KIND || (task.kind === "scan" && validationRepairId(task) !== null));
}

/** The repair a validation scan tests, or null for any other task. */
export function validationRepairId(task: Pick<Task, "kind" | "input">): number | null {
  if (task.kind !== "scan") return null;
  const id = (task.input as { skillOverride?: { repairId?: unknown } } | null)?.skillOverride?.repairId;
  return typeof id === "number" && Number.isInteger(id) ? id : null;
}

const repairOfTask = (conn: Conn, task: Pick<Task, "id" | "kind" | "input">): SkillRepair | undefined => {
  const validated = validationRepairId(task);
  if (validated !== null) {
    const r = getSkillRepair(conn, validated);
    return r?.validationTaskId === task.id ? r : undefined;
  }
  return listActiveSkillRepairs(conn).find((r) => r.repairTaskId === task.id);
};

const isActive = (r: Pick<SkillRepair, "status">): boolean => r.status === "queued" || r.status === "drafting" || r.status === "validating" || r.status === "adopting";

function progress(core: EngineCore, conn: Conn, r: SkillRepair, status: "queued" | "drafting" | "validating"): void {
  core.bus.emit(conn, { type: "skill_repair.progress", repairId: String(r.id), source: r.source, trigger: r.trigger, status });
}

function failedScanRun(conn: Conn, r: SkillRepair): number | null {
  return r.taskId === null ? null : (getTask(conn, r.taskId)?.runId ?? null);
}

// ---------------------------------------------------------------- trigger

/**
 * In the transaction that reports a research.scan that failed for good (noticeTaskFailed, after the
 * "<Source> adapter broken" line): start a repair when the failure is a broken adapter on the
 * browser path. Never throws (a repair bug must not break the failure it reacts to).
 */
export function onScanFailedForGood(core: EngineCore, conn: Conn, task: Task, error: string): void {
  if (taskKey(task.botName, task.kind) !== "research.scan" || isSkillRepairTask(task)) return;
  if (!core.deps.skills || !ADAPTER_BROKEN.test(error) || !task.usesBrowser) return;
  const source = (task.input as { source?: unknown } | null)?.source;
  if (typeof source !== "string" || !isSkillSource(source)) return;
  try {
    conn.transaction((sp) => startRepair(core, sp, { source, trigger: error, taskId: task.id, runId: task.runId, manual: false }));
  } catch (err) {
    core.log.error(`could not start a skill repair for ${source}: ${errorMessage(err)}`);
  }
}

export type StartResult = "started" | "queued" | "active" | "paused" | "capped";

export function startRepair(core: EngineCore, conn: Conn, req: { source: string; trigger: string; taskId: number | null; runId: number | null; manual: boolean }): StartResult {
  const { source } = req;
  if (listActiveSkillRepairs(conn).some((r) => r.source === source)) return "active";
  const state = getSkillRepairSource(conn, source);
  if (!req.manual && state.pausedAt !== null) {
    postNotice(core, conn, {
      text: `Automatic repair for ${sourceLabel(source)} is paused after ${SKILL_REPAIR_PAUSE_AFTER} failed attempts. Scans keep the previous skill.`,
      runId: req.runId,
      cards: [{ type: "activity_link" }],
      // Once per pause (and per run): not on every failure while it lasts.
      once: `skill-repair-paused:${source}:${state.pausedAt}`,
    });
    return "paused";
  }
  if (!req.manual && countSkillRepairsSince(conn, source, new Date(core.now().getTime() - DAY_MS).toISOString()) >= SKILL_REPAIR_DAILY_CAP) {
    core.log.info(`skill repair for ${source} skipped: ${SKILL_REPAIR_DAILY_CAP} attempts in the last 24 hours`);
    return "capped";
  }
  const busy = listActiveSkillRepairs(conn).length > 0;
  const row = insertSkillRepair(conn, { source, trigger: req.trigger, status: busy ? "queued" : "drafting", taskId: req.taskId, manual: req.manual }, { now: core.now() });
  if (!row) return "active";
  if (busy) {
    progress(core, conn, row, "queued");
    return "queued";
  }
  draft(core, conn, row);
  return "started";
}

/** The next queued repair, once none runs (one at a time: Chrome is shared). */
function startNextQueued(core: EngineCore, conn: Conn): void {
  const active = listActiveSkillRepairs(conn);
  if (active.some((r) => r.status !== "queued")) return;
  const next = active[0];
  if (next) draft(core, conn, updateSkillRepair(conn, next.id, { status: "drafting" }));
}

// ---------------------------------------------------------------- draft

function requiredNote(skill: string, re: RegExp, fallback: string): string {
  return re.exec(skill)?.[1] ?? fallback;
}

/** Queue the research.repair task (no run; behind every run's browser tasks). */
function draft(core: EngineCore, conn: Conn, r: SkillRepair): void {
  const skills = core.deps.skills;
  if (!skills || !isSkillSource(r.source)) return notAdopted(core, conn, r, "skill repair is not available for this source", null);
  let current: string;
  try {
    current = skills.read(r.source);
  } catch (err) {
    return notAdopted(core, conn, r, `the skill in force could not be read: ${errorMessage(err)}`, null);
  }
  const failed = r.taskId === null ? undefined : getTask(conn, r.taskId);
  const scan = ResearchScanInputSchema.safeParse(failed?.input);
  if (!scan.success) return notAdopted(core, conn, r, "the failed scan's search criteria are gone", null);
  let bot;
  try {
    bot = effectiveBot(conn, core.deps.bots, REPAIR_BOT);
  } catch (err) {
    return notAdopted(core, conn, r, errorMessage(err), null);
  }
  if (!bot.enabled) return notAdopted(core, conn, r, "Research is turned off on the Bots screen", null);
  const adapter = SOURCE_ADAPTERS[r.source];
  const reason = r.trigger.replace(ADAPTER_BROKEN, "");
  const input: ResearchRepairInput = {
    source: scan.data.source,
    currentSkill: current,
    failure: { reason: reason.replace(SCREENSHOT, "").trim() || reason, screenshot: SCREENSHOT.exec(reason)?.[1]?.replace(/^not captured$/, "") || null },
    searchUrls: searchUrls(r.source, scan.data.criteria),
    requiredNotes: {
      layoutChanged: requiredNote(current, LAYOUT_NOTE, "Layout changed: <what is missing> on <page URL>"),
      noResults: requiredNote(current, NO_RESULTS_NOTE, "No results: the page says 0 jobs"),
    },
    limits: {
      jobLimit: scan.data.candidateLimit ?? scanJobLimit(scan.data.criteria.maxJobs),
      maxPageViews: adapter.maxPageViews,
      delaySec: adapter.minDelayMs > 0 ? { min: adapter.minDelayMs / 1000, max: adapter.maxDelayMs / 1000 } : null,
    },
    hosts: skillHosts(r.source),
  };
  const task = createTask(
    conn,
    {
      runId: null,
      stepId: null,
      botName: REPAIR_BOT,
      kind: REPAIR_KIND,
      engine: bot.def.engine,
      input,
      promptVersion: bot.def.promptVersion,
      ...taskNeeds(bot.def, REPAIR_KIND),
    },
    { now: core.now() },
  );
  if (isEnginePaused(conn, task.engine, { now: core.now() })) holdEngineTasks(conn, task.engine);
  progress(core, conn, updateSkillRepair(conn, r.id, { status: "drafting", repairTaskId: task.id }), "drafting");
}

/** A settled research.repair (in the settle transaction): screen the draft, then queue its validation scan. */
export function onRepairDraftDone(core: EngineCore, conn: Conn, task: Task, output: ResearchRepairOutput): void {
  const r = repairOfTask(conn, task);
  if (!r || r.status !== "drafting") return;
  const notApplied = output.otherChanges.map((c) => ({ file: c.file, change: c.change }));
  if (output.blocked) {
    const what = output.blocked.reason === "captcha" ? "a CAPTCHA" : "a login wall";
    return notAdopted(core, conn, r, `the repair task was stopped by ${what} on ${output.blocked.site}`, null, notApplied);
  }
  if (output.injectionSuspected) {
    return notAdopted(core, conn, r, `a page tried to instruct the repair task${output.injectionNote ? ` (${output.injectionNote.slice(0, 200)})` : ""}`, null, notApplied);
  }
  const current = (task.input as { currentSkill?: unknown } | null)?.currentSkill;
  if (typeof current !== "string" || !isSkillSource(r.source)) return notAdopted(core, conn, r, "the repair task's input is gone", null, notApplied);
  const bot = core.deps.bots.get(REPAIR_BOT);
  const verdict = screenSkillDraft(output.skillMd, skillScreenContext(r.source, { allowedTools: bot?.allowedTools ?? [], current }));
  if (!verdict.ok) return notAdopted(core, conn, r, `the draft failed the safety screen: ${verdict.reason}`, output.skillMd, notApplied);
  if (output.skillMd.replace(/\r\n?/g, "\n").trim() === current.replace(/\r\n?/g, "\n").trim()) {
    return notAdopted(core, conn, r, "the draft is the same as the skill in force", null, notApplied);
  }
  const failed = r.taskId === null ? undefined : getTask(conn, r.taskId);
  const scan = ResearchScanInputSchema.parse(failed?.input);
  const { skillOverride: _ignored, ...criteria } = scan;
  const validation = createTask(
    conn,
    {
      runId: null,
      stepId: null,
      botName: REPAIR_BOT,
      kind: "scan",
      engine: task.engine,
      input: { ...criteria, skillOverride: { repairId: r.id } },
      promptVersion: task.promptVersion ?? 0,
      usesBrowser: true,
      usesFigma: false,
    },
    { now: core.now() },
  );
  if (isEnginePaused(conn, validation.engine, { now: core.now() })) holdEngineTasks(conn, validation.engine);
  const next = updateSkillRepair(conn, r.id, { status: "validating", draftMd: output.skillMd, otherChanges: notApplied, validationTaskId: validation.id });
  progress(core, conn, next, "validating");
}

/** The drafted skill a validation scan follows, or null when its repair is no longer validating it. */
export function skillOverrideFor(conn: Conn, task: Pick<Task, "id" | "kind" | "input">): { skillMd: string } | null {
  const id = validationRepairId(task);
  if (id === null) return null;
  const r = getSkillRepair(conn, id);
  return r && r.status === "validating" && r.validationTaskId === task.id && r.draftMd ? { skillMd: r.draftMd } : null;
}

// ---------------------------------------------------------------- validate and adopt

/**
 * A validation scan passed the schema, its self-check and the ScanOutputChecker (in the settle
 * transaction). 0 jobs or a reported injection end the attempt; otherwise the repair is marked
 * "adopting" and adoptValidatedRepair writes the file once this transaction is committed.
 */
export function onValidationDone(core: EngineCore, conn: Conn, task: Task, output: ResearchScanOutput): void {
  const r = repairOfTask(conn, task);
  if (!r || r.status !== "validating") return;
  if (output.blocked) return notAdopted(core, conn, r, `the validation scan was stopped by ${output.blocked.reason === "captcha" ? "a CAPTCHA" : "a login wall"} on ${output.blocked.site}`, r.draftMd, r.otherChanges);
  if (output.jobs.length === 0) return notAdopted(core, conn, r, "the validation scan returned 0 jobs", r.draftMd, r.otherChanges);
  if (output.injectionSuspected) return notAdopted(core, conn, r, "a page tried to instruct the bot during the validation scan", r.draftMd, r.otherChanges);
  updateSkillRepair(conn, r.id, { status: "adopting" });
}

/**
 * SEC-14: commit the "adopted" entry (with the text in force now) first, then replace the file. A
 * failed replace appends "not adopted"; the file is unchanged. Outside any transaction. Never throws.
 */
export function adoptValidatedRepair(core: EngineCore, task: Pick<Task, "id" | "kind" | "input">): void {
  const skills = core.deps.skills;
  const id = validationRepairId(task);
  if (!skills || id === null) return;
  const r = getSkillRepair(core.db, id);
  if (!r || r.status !== "adopting" || r.validationTaskId !== task.id || !r.draftMd) return;
  const end = (ended: Ended) => {
    try {
      core.db.transaction((tx) => {
        const current = getSkillRepair(tx, r.id)!;
        if (ended.kind === "adopted") finish(core, tx, current, ended);
        else notAdopted(core, tx, current, ended.reason, current.draftMd, current.otherChanges);
      });
    } catch (err) {
      core.log.error(`could not record the end of skill repair ${r.id}: ${errorMessage(err)}`);
    } finally {
      core.bus.flush();
    }
  };
  let previous: string;
  try {
    previous = skills.read(r.source);
  } catch (err) {
    return end({ kind: "not_adopted", reason: `the skill in force could not be read: ${errorMessage(err)}` });
  }
  try {
    core.db.transaction((tx) => {
      updateSkillRepair(tx, r.id, { previousMd: previous });
      core.bus.emit(tx, {
        type: "skill_repair.adopted",
        repairId: String(r.id),
        source: r.source,
        trigger: r.trigger,
        path: skills.pathOf(r.source),
        previousText: previous,
        newText: r.draftMd!,
        notApplied: r.otherChanges,
      });
    });
    core.bus.flush();
  } catch (err) {
    core.log.error(`skill repair ${r.id}: the activity entry could not be written, so the skill is not replaced: ${errorMessage(err)}`);
    return end({ kind: "not_adopted", reason: "the activity entry could not be written" });
  }
  try {
    skills.write(r.source, r.draftMd);
  } catch (err) {
    return end({ kind: "not_adopted", reason: `the skill file could not be replaced: ${errorMessage(err)}` });
  }
  end({ kind: "adopted" });
}

function finish(core: EngineCore, conn: Conn, r: SkillRepair, _ended: { kind: "adopted" }): void {
  updateSkillRepair(conn, r.id, { status: "adopted", finishedAt: core.now().toISOString() });
  setSkillRepairSource(conn, { source: r.source, failures: 0, pausedAt: null });
  postNotice(core, conn, {
    text: `Automatic repair worked: ${sourceLabel(r.source)}'s skill was updated and passed a validation scan. Next scans use it.`,
    runId: failedScanRun(conn, r),
    cards: [{ type: "activity_link" }],
  });
  startNextQueued(core, conn);
}

/** The attempt ends without touching the file: log it, count it, maybe pause, tell Ba, start the next one. */
function notAdopted(core: EngineCore, conn: Conn, r: SkillRepair, reason: string, draftMd: string | null, notApplied: { file: string; change: string }[] = []): void {
  updateSkillRepair(conn, r.id, { status: "not_adopted", reason, finishedAt: core.now().toISOString(), ...(draftMd !== null ? { draftMd } : {}), otherChanges: notApplied });
  core.bus.emit(conn, { type: "skill_repair.not_adopted", repairId: String(r.id), source: r.source, trigger: r.trigger, reason, draft: draftMd, notApplied });
  const state = getSkillRepairSource(conn, r.source);
  const failures = state.failures + 1;
  const pause = failures >= SKILL_REPAIR_PAUSE_AFTER && state.pausedAt === null;
  setSkillRepairSource(conn, { source: r.source, failures, pausedAt: pause ? core.now().toISOString() : state.pausedAt });
  if (pause) core.bus.emit(conn, { type: "skill_repair.paused", source: r.source, failures });
  postNotice(core, conn, {
    text: `Automatic repair failed: ${reason}. ${sourceLabel(r.source)} keeps its previous skill and later scans still use it.${pause ? ` Automatic repair for ${sourceLabel(r.source)} is paused after ${SKILL_REPAIR_PAUSE_AFTER} failed attempts.` : ""}`,
    runId: failedScanRun(conn, r),
    cards: [{ type: "activity_link" }],
  });
  startNextQueued(core, conn);
}

/** A repair or validation task failed for good (noticeTaskFailed routes it here instead of a scan notice). */
export function skillRepairTaskFailed(core: EngineCore, conn: Conn, task: Task, error: string): void {
  const r = repairOfTask(conn, task);
  if (!r || !isActive(r)) return;
  const what = task.kind === REPAIR_KIND ? "the repair task failed" : "the validation scan failed";
  notAdopted(core, conn, r, `${what}: ${error}`, task.kind === REPAIR_KIND ? null : r.draftMd, r.otherChanges);
}

/** SEC-13.AC-2: a successful browser scan of the source lifts its pause. */
export function onBrowserScanSucceeded(conn: Conn, task: Task): void {
  if (taskKey(task.botName, task.kind) !== "research.scan" || isSkillRepairTask(task) || !task.usesBrowser) return;
  const source = (task.input as { source?: unknown } | null)?.source;
  if (typeof source !== "string") return;
  const state = getSkillRepairSource(conn, source);
  if (state.failures > 0 || state.pausedAt !== null) setSkillRepairSource(conn, { source, failures: 0, pausedAt: null });
}

/**
 * Start-up: a repair whose task ended without reaching this flow (a cancel, a crash) ends as not
 * adopted; one that crashed while adopting is adopted when the file already holds its draft.
 */
export function reconcileSkillRepairs(core: EngineCore): void {
  if (!core.deps.skills) return;
  core.db.transaction((tx) => {
    for (const r of listActiveSkillRepairs(tx)) {
      if (r.status === "adopting") {
        let onDisk: string | null = null;
        try {
          onDisk = core.deps.skills!.read(r.source);
        } catch {
          onDisk = null;
        }
        if (onDisk !== null && onDisk === r.draftMd) finish(core, tx, r, { kind: "adopted" });
        else notAdopted(core, tx, r, "the orchestrator stopped before the skill file was replaced", r.draftMd, r.otherChanges);
        continue;
      }
      const taskId = r.status === "drafting" ? r.repairTaskId : r.status === "validating" ? r.validationTaskId : null;
      const t = taskId === null ? undefined : getTask(tx, taskId);
      if (r.status !== "queued" && (!t || t.status === "failed" || t.status === "done")) {
        notAdopted(core, tx, r, `the ${r.status === "drafting" ? "repair task" : "validation scan"} ended without a result (${t?.error ?? "interrupted"})`, r.draftMd, r.otherChanges);
      }
    }
    startNextQueued(core, tx);
  });
  core.bus.flush();
}

// ---------------------------------------------------------------- Ba's actions

/** Ba's "Try repair again" on a paused source: lift the pause and start a repair from its last failure. */
export function retrySkillRepair(core: EngineCore, source: string): StartResult {
  const result = core.db.transaction((tx) => {
    const last = listSkillRepairs(tx, { source }).at(-1);
    if (!last) throw new SkillRepairActionError("not_found", `there is no skill repair for ${source} to try again`);
    setSkillRepairSource(tx, { source, failures: 0, pausedAt: null });
    return startRepair(core, tx, { source, trigger: last.trigger, taskId: last.taskId, runId: null, manual: true });
  });
  core.bus.flush();
  core.dispatch();
  return result;
}

export class SkillRepairActionError extends Error {
  constructor(
    readonly code: "not_found" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "SkillRepairActionError";
  }
}

/** The latest adopted, unrestored repair of a source whose text the file still holds (§5.7), or null. */
function restorable(db: Db | Conn, skills: SkillFiles, r: SkillRepair): boolean {
  if (r.status !== "adopted" || r.restoredAt !== null || r.previousMd === null || r.draftMd === null) return false;
  const latest = listSkillRepairs(db, { source: r.source }).filter((x) => x.status === "adopted").at(-1);
  if (latest?.id !== r.id) return false;
  try {
    return skills.read(r.source) === r.draftMd;
  } catch {
    return false;
  }
}

/** Ba's "Restore previous skill" (§5.7): write back the text in force before the adopted repair. */
export function restoreSkill(core: EngineCore, repairId: number): void {
  const skills = core.deps.skills;
  if (!skills) throw new SkillRepairActionError("conflict", "skill repair is not available");
  const r = getSkillRepair(core.db, repairId);
  if (!r) throw new SkillRepairActionError("not_found", `there is no skill repair ${repairId}`);
  if (!restorable(core.db, skills, r)) {
    throw new SkillRepairActionError("conflict", "only the latest adopted repair can be restored, while the skill file still holds its text");
  }
  skills.write(r.source, r.previousMd!);
  core.db.transaction((tx) => {
    updateSkillRepair(tx, r.id, { restoredAt: core.now().toISOString() });
    core.bus.emit(tx, { type: "skill_repair.restored", repairId: String(r.id), source: r.source, trigger: r.trigger, path: skills.pathOf(r.source), previousText: r.draftMd!, newText: r.previousMd! });
  });
  core.bus.flush();
}

// ---------------------------------------------------------------- the Activity screen

const label = (source: string) => sourceLabel(source);

/** Skill repairs and API-path changes as Activity entries, newest first (REQ-11, §7). */
export function skillRepairActivity(db: Db, skills: SkillFiles | null): (SkillRepairActivityEntry | SourceApiActivityEntry)[] {
  const out: (SkillRepairActivityEntry | SourceApiActivityEntry)[] = [];
  const rows = new Map(listSkillRepairs(db).map((r) => [r.id, r]));
  const events = listEvents(db, {
    types: ["skill_repair.adopted", "skill_repair.not_adopted", "skill_repair.restored", "skill_repair.paused", "source_api.changed", "source_api.recovered"],
  });
  // One entry per attempt: its last outcome (an "adopted" entry followed by "not adopted" when the write failed).
  const lastOutcome = new Map<string, number>();
  events.forEach((e, i) => {
    const id = (e.payload as { repairId?: unknown }).repairId;
    if ((e.type === "skill_repair.adopted" || e.type === "skill_repair.not_adopted") && typeof id === "string") lastOutcome.set(id, i);
  });
  const lastPaused = new Map<string, number>();
  events.forEach((e, i) => {
    if (e.type === "skill_repair.paused") lastPaused.set(String((e.payload as { source: unknown }).source), i);
  });
  const base = { repairId: null, trigger: null, status: null, reason: null, path: null, previousText: null, newText: null, notApplied: [], canRestore: false, canRetry: false };
  events.forEach((e, i) => {
    const p = e.payload as Record<string, unknown>;
    const source = String(p.source ?? "");
    const common = { id: String(e.id), at: e.createdAt, source, sourceLabel: label(source) };
    switch (e.type) {
      case "skill_repair.adopted":
      case "skill_repair.not_adopted": {
        if (lastOutcome.get(String(p.repairId)) !== i) return;
        const row = rows.get(Number(p.repairId));
        const adopted = e.type === "skill_repair.adopted";
        out.push({
          ...base,
          ...common,
          kind: adopted ? "skill_adopted" : "skill_not_adopted",
          repairId: String(p.repairId),
          trigger: String(p.trigger ?? ""),
          reason: adopted ? null : String(p.reason ?? ""),
          path: adopted ? String(p.path ?? "") : null,
          previousText: adopted ? String(p.previousText ?? "") : (row?.previousMd ?? null),
          newText: adopted ? String(p.newText ?? "") : typeof p.draft === "string" ? p.draft : null,
          notApplied: (p.notApplied as { file: string; change: string }[] | undefined) ?? [],
          canRestore: adopted && row !== undefined && skills !== null && restorable(db, skills, row),
        });
        return;
      }
      case "skill_repair.restored":
        out.push({ ...base, ...common, kind: "skill_restored", repairId: String(p.repairId), trigger: String(p.trigger ?? ""), path: String(p.path ?? ""), previousText: String(p.previousText ?? ""), newText: String(p.newText ?? "") });
        return;
      case "skill_repair.paused": {
        const state = lastPaused.get(source) === i ? listSkillRepairs(db, { source }) : [];
        const stillPaused = state.length > 0 && isPaused(db, source);
        out.push({ ...base, ...common, kind: "skill_repair_paused", reason: `${String(p.failures)} attempts in a row were not adopted`, canRetry: stillPaused && !state.some(isActive) });
        return;
      }
      case "source_api.changed":
      case "source_api.recovered":
        out.push({
          ...common,
          kind: e.type === "source_api.changed" ? "api_changed" : "api_recovered",
          method: p.method === "GET" ? "GET" : null,
          host: typeof p.host === "string" ? p.host : null,
          path: typeof p.path === "string" ? p.path : null,
          reason: typeof p.reason === "string" ? p.reason : null,
        });
        return;
    }
  });
  for (const r of rows.values()) {
    if (!isActive(r)) continue;
    out.push({
      ...base,
      id: `repair-${r.id}`,
      at: r.createdAt,
      kind: "skill_repairing",
      repairId: String(r.id),
      source: r.source,
      sourceLabel: label(r.source),
      trigger: r.trigger,
      status: r.status === "adopting" ? "validating" : (r.status as "queued" | "drafting" | "validating"),
    });
  }
  return out.reverse();
}

function isPaused(db: Db | Conn, source: string): boolean {
  return getSkillRepairSource(db, source).pausedAt !== null;
}
