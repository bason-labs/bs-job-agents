// CV guidance refresh (§5.4; AD-10, AD-12, SEC-20 to SEC-24): the `guidance` step of a job-scan run,
// once per run, after `top` and before any branch step (workflow.ts holds the branches back until
// it settles). Engine-run with sub-tasks:
//   1. re-check (code, every run, no LLM): GET every web source of the current set through the
//      guidance fetcher (SEC-21), conditional where validators are known; an unchanged page ends here;
//   2. discovery (LLM, at most weekly, or when fewer than 3 non-VNPT hosts back the set): one
//      research.guidance_discover task with web search only; it returns URLs, which code fetches;
//   3. extraction (LLM, only for changed or new pages): one tool-less research.guidance_extract task
//      with the pages as quoted data;
//   4. screenGuidanceUpdate (AD-11), then commitGuidanceRuleSet once if anything changed, and one
//      guidance.refresh event (counts and reasons, no page text).
// Optional: a failure keeps the previous snapshot in force and tailoring goes on. Lead posts
// "CV guidance refresh failed: <reason>" only when no page could be read or the step failed. One
// refresh at a time across runs (a lock); a run that finds one in progress waits for it and uses its
// result; a run never refreshes twice (a late pass skips the step). Budget: 5 minutes.
import {
  GUIDANCE_DISCOVER_MAX_URLS,
  GUIDANCE_SEED,
  GuidanceDiscoverInputSchema,
  GuidanceExtractInputSchema,
  citedWebHosts,
  mergeGuidanceSeed,
  screenGuidanceUpdate,
  type FetchedGuidancePage,
  type GuidanceDiscoverOutput,
  type GuidanceExtractOutput,
  type GuidanceRuleSet,
  type TaskStepSchema,
} from "@bs-job-agents/shared";
import type { z } from "zod";
import { getStepByKey, getTask, listActiveRuns, type Conn, type Step } from "../db/index.js";
import {
  commitGuidanceRuleSet,
  currentGuidanceRuleSet,
  getGuidanceSettings,
  guidanceStoreState,
  guidanceLockHolder,
  markGuidanceDiscovery,
  releaseGuidanceLock,
  takeGuidanceLock,
} from "../db/repos/guidance.js";
import { appendAppEvent } from "../db/repos/events.js";
import type { RunCtx, Scope } from "./context.js";
import type { EngineCore } from "./core.js";
import { errorMessage } from "./errors.js";
import { postNotice } from "./notices.js";
import type { GuidanceFetchRequest, GuidanceFetchResult } from "./ports.js";
import { isTerminalStep, openStep, setStep } from "./steps.js";
import { createWorkflowTask, ensureStepRow } from "./task-factory.js";

type TaskStep = z.infer<typeof TaskStepSchema>;

export const GUIDANCE_TASK_KEY = "research.guidance_extract";
/** §6 OQ-6 caps. */
export const GUIDANCE_STEP_BUDGET_MS = 5 * 60_000;
/** F5: the lock outlives the budget, so a slow refresh is never taken over while it still runs. */
export const GUIDANCE_LOCK_STALE_MS = GUIDANCE_STEP_BUDGET_MS + 2 * 60_000;
export const GUIDANCE_MAX_PAGES = 15;
export const GUIDANCE_DISCOVERY_EVERY_MS = 7 * 24 * 3600_000;
export const GUIDANCE_MIN_HOSTS = 3;
/** The extraction batch's page text, in total (§5.4 step 3). */
export const GUIDANCE_EXTRACT_MAX_CHARS = 60_000;

export const isGuidanceStep = (step: TaskStep): boolean => `${step.task.bot}.${step.task.kind}` === GUIDANCE_TASK_KEY;

type Phase = "waiting_lock" | "fetching" | "discovering" | "fetching_candidates" | "extracting";

interface PageState {
  url: string;
  status: "unchanged" | "changed" | "new" | "failed";
  reason?: string;
  /** Changed and new pages: what was fetched (the extraction's input and the screen's evidence). */
  page?: FetchedGuidancePage;
}

/** steps.output_json while the refresh runs, and its summary when it settled. */
export interface GuidanceStepOutput {
  phase: Phase | "done";
  startedAt: string;
  holder: number | null;
  pages: PageState[];
  discovery: boolean;
  discoveryTaskId: number | null;
  extraction: boolean;
  extractTaskId: number | null;
  snapshot: number | null;
  outcome?: "unchanged" | "updated" | "failed" | "used_other_run";
  rulesChanged?: number;
  error?: string;
}

type StepState = "done" | "active" | "failed";

// ---------------------------------------------------------------- async fetch jobs

const JOBS = new WeakMap<EngineCore, Map<number, Promise<void>>>();

function jobsOf(core: EngineCore): Map<number, Promise<void>> {
  let m = JOBS.get(core);
  if (!m) JOBS.set(core, (m = new Map()));
  return m;
}

/** In-flight guidance fetches (Engine.idle waits for them). */
export function guidancePending(core: EngineCore): Promise<void>[] {
  return [...jobsOf(core).values()];
}

function startFetch(core: EngineCore, runId: number, stepId: number, startedAt: string, requests: GuidanceFetchRequest[], then: (tx: Conn, results: GuidanceFetchResult[]) => void): void {
  const jobs = jobsOf(core);
  if (jobs.has(stepId)) return;
  const fetcher = core.deps.guidance!.fetch;
  // F5: every hop of every page stops when the step's budget runs out.
  const remaining = Math.max(1, GUIDANCE_STEP_BUDGET_MS - (core.now().getTime() - Date.parse(startedAt)));
  const signal = AbortSignal.timeout(remaining);
  const promise = (async () => {
    let results: GuidanceFetchResult[];
    try {
      results = requests.length === 0 ? [] : await fetcher.fetchPages(requests, { signal });
    } catch (err) {
      results = requests.map((r) => ({ url: r.url, status: "failed" as const, reason: `the fetcher failed (${errorMessage(err)})` }));
    }
    core.db.transaction((tx) => then(tx, results));
  })()
    .catch((err: unknown) => core.log.error(`guidance fetch of run ${runId} failed: ${errorMessage(err)}`))
    .finally(() => {
      jobs.delete(stepId);
      core.advance(runId);
      core.dispatch();
    });
  jobs.set(stepId, promise);
}

// ---------------------------------------------------------------- seed

/** AD-10: commit whatever of the seed the current snapshot lacks, through the same screen and commit path. */
export function ensureGuidanceSeed(core: EngineCore, conn: Conn): void {
  const deps = core.deps.guidance;
  if (!deps) return;
  const seed = deps.seed ?? GUIDANCE_SEED;
  const state = guidanceStoreState(conn);
  // F8: an unreadable newest snapshot is never covered up by re-committing the seed.
  if (state.corrupt) {
    core.log.warn(`CV guidance snapshot ${state.latestNumber} cannot be read; snapshot ${state.current?.snapshot ?? "none"} stays in force and the seed is not re-committed`);
    return;
  }
  const current = state.current;
  const merged = mergeGuidanceSeed(current?.ruleSet ?? { sources: [], rules: [] }, seed);
  if (!merged.changed) return;
  commitGuidanceRuleSet(conn, { runId: null, ruleSet: merged.ruleSet }, { now: core.now() });
}

// ---------------------------------------------------------------- the step

function emptyOutput(core: EngineCore, phase: Phase): GuidanceStepOutput {
  return { phase, startedAt: core.now().toISOString(), holder: null, pages: [], discovery: false, discoveryTaskId: null, extraction: false, extractTaskId: null, snapshot: null };
}

const preview = (out: GuidanceStepOutput): string => {
  const checked = out.pages.length;
  switch (out.phase) {
    case "waiting_lock":
      return `waiting for the refresh of run ${out.holder}`;
    case "fetching":
    case "fetching_candidates":
      return "checking CV guidance sources";
    case "discovering":
      return "looking for new CV guidance sources";
    case "extracting":
      return `reading ${out.pages.filter((p) => p.page).length} changed page(s)`;
    default:
      if (out.outcome === "used_other_run") return "used another run's refresh";
      if (out.outcome === "failed") return `refresh failed${out.error ? `: ${out.error}` : ""}`;
      return `${checked} source${checked === 1 ? "" : "s"} checked · ${out.rulesChanged ?? 0} rule${out.rulesChanged === 1 ? "" : "s"} changed`;
  }
};

/** skipIfEmpty: the named step produced no items (no top job → no refresh). */
function sourceEmpty(conn: Conn, ctx: RunCtx, key: string): boolean {
  const out = getStepByKey(conn, ctx.run.id, key, "")?.output as { items?: unknown[]; results?: unknown[] } | null | undefined;
  const items = out?.items ?? out?.results;
  return !Array.isArray(items) || items.length === 0;
}

export function advanceGuidanceStep(core: EngineCore, ctx: RunCtx, step: TaskStep, scope: Scope): StepState {
  const conn = core.db;
  const row = getStepByKey(conn, ctx.run.id, step.key, scope.branchKey);
  if (row && isTerminalStep(row)) return "done";
  if (!row || row.status === "pending") {
    return conn.transaction((tx): StepState => {
      // SEC-24.AC-1: one refresh per run; a follow-up pass never starts a second one.
      if (scope.branchKey !== "") return skip(core, tx, ctx, step, scope, "refreshed once per run");
      if (step.skipIfEmpty && sourceEmpty(tx, ctx, step.skipIfEmpty)) return skip(core, tx, ctx, step, scope, "no top job, no refresh");
      if (!core.deps.guidance) return skip(core, tx, ctx, step, scope, "CV guidance is not wired");
      ensureGuidanceSeed(core, tx);
      const store = guidanceStoreState(tx);
      if (store.corrupt) {
        // F8: no refresh on top of an unreadable snapshot; the last readable one stays in force.
        const out = emptyOutput(core, "fetching");
        const opened = openStep(core, tx, ctx, step.key, scope, "running", { output: out });
        fail(core, tx, ctx, opened, out, `the stored rule set (snapshot ${store.latestNumber}) cannot be read, so snapshot ${store.current?.snapshot ?? "none"} stays in force`);
        return "done";
      }
      const lock = takeGuidanceLock(tx, ctx.run.id, core.now(), GUIDANCE_LOCK_STALE_MS);
      if (!lock.held) {
        const out = { ...emptyOutput(core, "waiting_lock"), holder: lock.holder };
        openStep(core, tx, ctx, step.key, scope, "running", { output: out, preview: preview(out) });
        return "active";
      }
      const out = emptyOutput(core, "fetching");
      const opened = openStep(core, tx, ctx, step.key, scope, "running", { output: out, preview: preview(out) });
      startSourceFetch(core, ctx, opened);
      return "active";
    });
  }
  return conn.transaction((tx) => poll(core, tx, ctx, getStepByKey(tx, ctx.run.id, step.key, scope.branchKey)!));
}

function skip(core: EngineCore, tx: Conn, ctx: RunCtx, step: TaskStep, scope: Scope, note: string): StepState {
  openStep(core, tx, ctx, step.key, scope, "skipped", { output: { note }, preview: note });
  return "done";
}

function poll(core: EngineCore, tx: Conn, ctx: RunCtx, row: Step): StepState {
  const out = structuredClone(row.output as GuidanceStepOutput);
  if (isTerminalStep(row)) return "done";
  const elapsed = core.now().getTime() - Date.parse(out.startedAt);
  if (out.phase === "waiting_lock") {
    const holder = guidanceLockHolder(tx, core.now(), GUIDANCE_LOCK_STALE_MS);
    if (holder !== null && holder !== ctx.run.id && elapsed <= GUIDANCE_LOCK_STALE_MS) return "active";
    // The other run's refresh ended (or timed out): this run uses its result.
    const snapshot = currentGuidanceRuleSet(tx)?.snapshot ?? null;
    const done: GuidanceStepOutput = { ...out, phase: "done", outcome: "used_other_run", snapshot, rulesChanged: 0 };
    recordRefresh(core, tx, ctx, done, [], 0);
    setStep(core, tx, row, "done", { output: done, preview: preview(done) });
    return "done";
  }
  if (elapsed > GUIDANCE_STEP_BUDGET_MS) return fail(core, tx, ctx, row, out, `it took longer than ${GUIDANCE_STEP_BUDGET_MS / 60_000} minutes`);
  switch (out.phase) {
    case "fetching":
      // A restart lost the in-memory fetch: start it again.
      if (!jobsOf(core).has(row.id)) startSourceFetch(core, ctx, row);
      return "active";
    case "fetching_candidates":
      if (!jobsOf(core).has(row.id)) startCandidateFetch(core, ctx, row, discoveredUrls(tx, out));
      return "active";
    case "discovering": {
      const task = out.discoveryTaskId === null ? undefined : getTask(tx, out.discoveryTaskId);
      if (!task || task.status === "failed" || task.status === "interrupted") {
        core.log.warn(`guidance discovery of run ${ctx.run.id} failed (${task?.error ?? "no task"}); the refresh goes on with the known sources`);
        return toExtraction(core, tx, ctx, row, out);
      }
      if (task.status !== "done") return "active";
      const urls = discoveredUrls(tx, out);
      const next = { ...out, phase: "fetching_candidates" as const };
      setStep(core, tx, row, "running", { output: next, preview: preview(next) });
      startCandidateFetch(core, ctx, row, urls);
      return "active";
    }
    case "extracting": {
      const task = out.extractTaskId === null ? undefined : getTask(tx, out.extractTaskId);
      if (!task || task.status === "failed" || task.status === "interrupted") return fail(core, tx, ctx, row, out, `the rule extraction failed (${task?.error ?? "no task"})`);
      if (task.status !== "done") return "active";
      return finish(core, tx, ctx, row, out, (task.output as GuidanceExtractOutput).drafts);
    }
    default:
      return "active";
  }
}

/** Step 1: the known web sources, conditional where validators are known (≤ 15 pages). */
function startSourceFetch(core: EngineCore, ctx: RunCtx, row: Step): void {
  const set = currentGuidanceRuleSet(core.db)?.ruleSet;
  const sources = (set?.sources ?? []).filter((s) => s.url !== null).slice(0, GUIDANCE_MAX_PAGES);
  const requests = sources.map((s) => ({ url: s.url!, etag: s.etag, lastModified: s.lastModified }));
  startFetch(core, ctx.run.id, row.id, (row.output as GuidanceStepOutput).startedAt, requests, (tx, results) => {
    const current = getStepByKey(tx, ctx.run.id, row.stepKey, row.branchKey);
    if (!current || isTerminalStep(current)) return;
    const out = structuredClone(current.output as GuidanceStepOutput);
    out.pages = results.map((r): PageState => {
      const known = sources.find((s) => s.url === r.url);
      if (r.status === "failed") return { url: r.url, status: "failed", reason: r.reason };
      if (r.status === "not_modified" || (known && known.contentHash === r.contentHash)) return { url: r.url, status: "unchanged" };
      return { url: r.url, status: "changed", page: toPage(r) };
    });
    afterSourceFetch(core, tx, ctx, current, out, set ?? { sources: [], rules: [] });
  });
}

function toPage(r: Extract<GuidanceFetchResult, { status: "ok" }>): FetchedGuidancePage {
  return { url: r.url, finalUrl: r.finalUrl, title: r.title, text: r.text, host: r.host, kind: r.kind, market: r.market, contentHash: r.contentHash, etag: r.etag, lastModified: r.lastModified };
}

/** Step 2 when due: one URL-only discovery task. Else on to extraction. */
function afterSourceFetch(core: EngineCore, tx: Conn, ctx: RunCtx, row: Step, out: GuidanceStepOutput, set: GuidanceRuleSet): void {
  const settings = getGuidanceSettings(tx);
  const due = settings.lastDiscoveryAt === null || core.now().getTime() - Date.parse(settings.lastDiscoveryAt) > GUIDANCE_DISCOVERY_EVERY_MS || citedWebHosts(set).length < GUIDANCE_MIN_HOSTS;
  const room = GUIDANCE_MAX_PAGES - out.pages.length;
  if (due && room > 0 && core.deps.bots.get("research")) {
    const knownHosts = [...new Set(set.sources.map((s) => s.host))];
    const kinds = new Set(set.sources.map((s) => s.kind));
    const wanted = [
      ...(kinds.has("vn_recruiter") ? [] : ["a Vietnamese IT recruiter's or job board's CV advice page"]),
      ...(kinds.has("global_recruiter") ? [] : ["a global recruiter's or career site's CV advice page"]),
      ...(kinds.has("ats_vendor") ? [] : ["an applicant-tracking-system vendor's guide to ATS-safe CVs"]),
    ];
    const input = GuidanceDiscoverInputSchema.parse({ knownHosts, wanted: wanted.length > 0 ? wanted : ["another recruiter's CV advice page for software engineers"], maxUrls: Math.min(GUIDANCE_DISCOVER_MAX_URLS, room) });
    const scope = { branchKey: row.branchKey };
    const { task } = createWorkflowTask(core, tx, ctx, ensureStepRow(tx, ctx, row.stepKey, scope), { bot: "research", kind: "guidance_discover", input: {} }, scope, { prebuilt: input });
    // At most weekly even if this one fails.
    markGuidanceDiscovery(tx, core.now().toISOString());
    const next: GuidanceStepOutput = { ...out, phase: "discovering", discovery: true, discoveryTaskId: task.id };
    setStep(core, tx, row, "running", { output: next, preview: preview(next) });
    return;
  }
  toExtraction(core, tx, ctx, row, out);
}

/** The discovery task's URLs: https, new, unique, within the page cap. */
function discoveredUrls(conn: Conn, out: GuidanceStepOutput): string[] {
  const task = out.discoveryTaskId === null ? undefined : getTask(conn, out.discoveryTaskId);
  const urls = task?.status === "done" ? (task.output as GuidanceDiscoverOutput).urls : [];
  const known = new Set([...(currentGuidanceRuleSet(conn)?.ruleSet.sources ?? []).map((s) => s.url), ...out.pages.map((p) => p.url)]);
  const fresh: string[] = [];
  for (const u of urls) {
    const url = u.trim();
    if (!url.startsWith("https://") || known.has(url) || fresh.includes(url)) continue;
    fresh.push(url);
  }
  return fresh.slice(0, Math.max(0, GUIDANCE_MAX_PAGES - out.pages.length));
}

function startCandidateFetch(core: EngineCore, ctx: RunCtx, row: Step, urls: string[]): void {
  startFetch(core, ctx.run.id, row.id, (row.output as GuidanceStepOutput).startedAt, urls.map((url) => ({ url, etag: null, lastModified: null })), (tx, results) => {
    const current = getStepByKey(tx, ctx.run.id, row.stepKey, row.branchKey);
    if (!current || isTerminalStep(current)) return;
    const out = structuredClone(current.output as GuidanceStepOutput);
    for (const r of results) {
      if (r.status === "ok") out.pages.push({ url: r.url, status: "new", page: toPage(r) });
      else out.pages.push({ url: r.url, status: "failed", reason: r.status === "failed" ? r.reason : "not modified" });
    }
    toExtraction(core, tx, ctx, current, out);
  });
}

/** Step 3: one tool-less extraction for the changed and new pages, or straight to the screen. */
function toExtraction(core: EngineCore, tx: Conn, ctx: RunCtx, row: Step, out: GuidanceStepOutput): StepState {
  const pages = out.pages.filter((p) => p.page).map((p) => p.page!);
  const web = out.pages.filter((p) => p.status !== "new");
  if (web.length > 0 && web.every((p) => p.status === "failed") && pages.length === 0) {
    return fail(core, tx, ctx, row, out, `no guidance page could be read (${web.map((p) => p.reason).filter(Boolean).slice(0, 2).join("; ")})`);
  }
  if (pages.length === 0) return finish(core, tx, ctx, row, out, []);
  const set = currentGuidanceRuleSet(tx)?.ruleSet ?? { sources: [], rules: [] };
  const share = Math.floor(GUIDANCE_EXTRACT_MAX_CHARS / pages.length);
  const input = GuidanceExtractInputSchema.parse({
    rules: set.rules.map((r) => ({ ruleId: r.id, topic: r.topic, point: r.point, positions: r.positions.map((p) => ({ positionId: p.id, text: p.text })) })),
    pages: pages.map((p) => ({ url: p.finalUrl, title: p.title, text: p.text.slice(0, share) })),
  });
  const scope = { branchKey: row.branchKey };
  const { task } = createWorkflowTask(core, tx, ctx, row, { bot: "research", kind: "guidance_extract", input: {} }, scope, { prebuilt: input });
  const next: GuidanceStepOutput = { ...out, phase: "extracting", extraction: true, extractTaskId: task.id };
  setStep(core, tx, row, "running", { output: next, preview: preview(next) });
  return "active";
}

/** Step 4: screen, commit once if anything changed, record the refresh, release the lock. */
function finish(core: EngineCore, tx: Conn, ctx: RunCtx, row: Step, out: GuidanceStepOutput, drafts: readonly unknown[]): StepState {
  const current = currentGuidanceRuleSet(tx);
  const set = current?.ruleSet ?? { sources: [], rules: [] };
  const fetched = out.pages.filter((p) => p.page).map((p) => p.page!);
  const screened = screenGuidanceUpdate(set, drafts, fetched, core.now().toISOString());
  let snapshot = current?.snapshot ?? null;
  let rulesChanged = 0;
  const reasons = [...out.pages.filter((p) => p.status === "failed").map((p) => `${p.url}: ${p.reason ?? "failed"}`), ...screened.rejected.map((r) => `draft ${r.index + 1}${r.ruleId ? ` (${r.ruleId})` : ""}: ${r.reason}`)];
  if (screened.changed) {
    try {
      // A savepoint: a failed commit rolls back its own rows only (SEC-24.AC-3).
      const committed = tx.transaction((sp) => commitGuidanceRuleSet(sp, { runId: ctx.run.id, ruleSet: screened.ruleSet }, { now: core.now() }));
      snapshot = committed.snapshot;
      rulesChanged = committed.changes.length;
    } catch (err) {
      for (const c of screened.changes) {
        const entry = { snapshot: (snapshot ?? 0) + 1, runId: String(ctx.run.id), ruleId: c.ruleId, point: c.point, previousText: c.previousText, newText: c.newText, sourceIds: c.sourceIds, applied: false };
        appendAppEvent(tx, c.kind === "rule_added" ? { type: "guidance.rule_added", ...entry } : { type: "guidance.rule_changed", ...entry }, { now: core.now() });
      }
      return fail(core, tx, ctx, row, { ...out, snapshot }, `the new rule set could not be saved (${errorMessage(err)})`);
    }
  }
  const done: GuidanceStepOutput = { ...out, phase: "done", snapshot, outcome: screened.changed ? "updated" : "unchanged", rulesChanged, pages: out.pages.map(({ page: _page, ...p }) => p) };
  recordRefresh(core, tx, ctx, done, reasons, screened.accepted, screened.rejected.length);
  releaseGuidanceLock(tx, ctx.run.id);
  wakeWaitingRuns(core, ctx.run.id);
  setStep(core, tx, row, "done", { output: done, preview: preview(done) });
  return "done";
}

/** The refresh failed: the previous snapshot stays in force; Lead tells Ba (only for these cases). */
function fail(core: EngineCore, tx: Conn, ctx: RunCtx, row: Step, out: GuidanceStepOutput, reason: string): StepState {
  const done: GuidanceStepOutput = { ...out, phase: "done", outcome: "failed", error: reason, rulesChanged: 0, snapshot: currentGuidanceRuleSet(tx)?.snapshot ?? null, pages: out.pages.map(({ page: _page, ...p }) => p) };
  recordRefresh(core, tx, ctx, done, out.pages.filter((p) => p.status === "failed").map((p) => `${p.url}: ${p.reason ?? "failed"}`), 0, 0, reason);
  releaseGuidanceLock(tx, ctx.run.id);
  wakeWaitingRuns(core, ctx.run.id);
  postNotice(core, tx, { text: `CV guidance refresh failed: ${reason}. Tailoring goes on with the rules from the last successful check.`, runId: ctx.run.id, cards: [{ type: "guidance_link" }], once: "guidance-refresh-failed" });
  setStep(core, tx, row, "failed", { output: done, error: reason, preview: preview(done) });
  return "failed";
}

/** Runs waiting for this refresh go on once its transaction committed (they use its result). */
function wakeWaitingRuns(core: EngineCore, self: number): void {
  void Promise.resolve().then(() => {
    for (const run of listActiveRuns(core.db)) if (run.id !== self) core.advance(run.id);
    core.dispatch();
  });
}

function recordRefresh(core: EngineCore, tx: Conn, ctx: RunCtx, out: GuidanceStepOutput, reasons: string[], accepted: number, rejected = 0, error: string | null = null): void {
  const count = (s: PageState["status"]) => out.pages.filter((p) => p.status === s).length;
  appendAppEvent(
    tx,
    {
      type: "guidance.refresh",
      runId: String(ctx.run.id),
      outcome: out.outcome ?? "unchanged",
      snapshot: out.snapshot,
      pagesChecked: out.pages.length,
      unchanged: count("unchanged"),
      changed: count("changed") + count("new"),
      failed: count("failed"),
      draftsAccepted: accepted,
      draftsRejected: rejected,
      rulesChanged: out.rulesChanged ?? 0,
      discovery: out.discovery,
      extraction: out.extraction,
      reasons: reasons.slice(0, 20).map((r) => (r.length > 300 ? `${r.slice(0, 297)}...` : r)),
      error,
    },
    { now: core.now() },
  );
}
