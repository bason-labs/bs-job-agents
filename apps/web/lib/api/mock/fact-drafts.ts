// The mock orchestrator's facts-from-Ba's-words flow (owner request 2026-10-11), mirroring
// apps/orchestrator/src/api/fact-drafts.ts and routes/master-cv.ts: POST /master-cv/facts/draft
// queues a simulated cv.fact_draft (a short wait), which drafts one fact from Ba's own sentence (or
// none when he says no), passes the shared invented-detail guard, and adds it as a new master
// version; the request closes. GET reads the draft; POST /master-cv/facts/undo restores the version
// before, only while it is the latest change.
import {
  FactDraftRequestSchema,
  FactUndoRequestSchema,
  MasterCvSchema,
  draftedToFact,
  screenDraftedFacts,
  withFreeFactIds,
  type DraftedFact,
  type FactDraftRetailor,
  type FactDraftView,
  type FactRequestItem,
  type MasterCv,
} from "@bs-job-agents/shared";
import { ApiRequestError } from "../errors";
import type { MockBackend } from "./backend";

/** How long the simulated CV takes (divided by the mock's speed). */
export const MOCK_FACT_DRAFT_MS = 1500;

/** A draft as the mock keeps it: the view plus what Undo and the re-tailor offer need. */
export interface MockFactDraft {
  view: FactDraftView;
  request: FactRequestItem | null;
  /** The master CV before the facts were added (Undo restores it). */
  before: MasterCv | null;
}

const fail = (status: number, code: ApiRequestError["code"], message: string, details: unknown = null) => new ApiRequestError({ status, code, message, details });

function parseBody<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } } }, value: unknown): T {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  throw fail(400, "validation_failed", r.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; "), r.error.issues);
}

/** What a faithful CV drafts from Ba's words: his own sentence, at the role he names; nothing when he says no. */
export function mockDraftFacts(text: string, request: FactRequestItem | null, cv: MasterCv): { facts: DraftedFact[]; notes: string | null } {
  const said = text.trim();
  if (/^(no|nope|not really|không|chưa)\b/i.test(said)) return { facts: [], notes: "You said no, so I added nothing. CV goes on without it." };
  const role = cv.facts.find((f) => f.org && said.toLowerCase().includes(f.org.toLowerCase()) && f.type === "experience");
  const sentence = said.replace(/^(yes|yeah|có|rồi)[,.!\s]+/i, "").trim() || said;
  const prefix = role ? role.id.replace(/-\d+$/, "") : "skill";
  return {
    facts: [
      {
        id: `${prefix}-1`,
        type: role ? "experience" : "skill",
        text: sentence.charAt(0).toUpperCase() + sentence.slice(1),
        textVi: sentence,
        tags: request ? [request.topic.toLowerCase()] : [],
        org: role?.org ?? null,
        dates: role?.dates ?? null,
      },
    ],
    notes: null,
  };
}

/** The job's tailor steps in its run (mock runs keep one per job and language). */
function retailorFor(core: MockBackend, jobId: string, company: string): FactDraftRetailor {
  const runs = Object.values(core.state.runs).filter((r) => r.steps.some((s) => s.stepKey === "tailor" && (s.branchKey ?? "").split(":")[0] === jobId));
  const run = runs.at(-1);
  if (!run) return { jobId, company, stepIds: [], note: `${company}'s CV was not tailored in a run I can re-run; ask Lead to tailor it again.` };
  if (run.run.status === "cancelled") return { jobId, company, stepIds: [], note: `${company}'s run was cancelled; ask Lead to tailor its CV again.` };
  return { jobId, company, stepIds: run.steps.filter((s) => s.stepKey === "tailor" && (s.branchKey ?? "").split(":")[0] === jobId).map((s) => s.id), note: null };
}

function drafts(core: MockBackend): Record<string, MockFactDraft> {
  core.state.factDrafts ??= {};
  return core.state.factDrafts;
}

/** POST /master-cv/facts/draft → 202 { taskId }. */
export function startFactDraft(core: MockBackend, body: unknown): { taskId: string } {
  const req = parseBody(FactDraftRequestSchema, body);
  const m = core.state.masterCv;
  if (m.kind === "missing") throw fail(409, "conflict", "create your master CV first, then add facts to it", { reason: "master_cv_missing" });
  if (m.kind === "invalid") throw fail(409, "conflict", `data/master-cv.yaml cannot be read: ${m.detail}`, { reason: "master_cv_invalid" });
  if (req.version !== m.cv.version) {
    throw fail(409, "conflict", `the master CV changed since you opened it (now version ${m.cv.version}); reload it first`, { reason: "master_cv_changed", currentVersion: m.cv.version });
  }
  const requestId = req.factRequestId ?? null;
  const request = requestId === null ? null : (core.state.factRequests.find((r) => r.id === requestId) ?? null);
  if (requestId !== null && !request) throw fail(404, "not_found", `there is no open fact request ${requestId}`);
  const pending = Object.values(drafts(core)).find((d) => d.view.factRequestId === requestId && requestId !== null && (d.view.status === "queued" || d.view.status === "running"));
  if (pending) throw fail(409, "conflict", "CV is already drafting an answer to this question", { reason: "draft_pending", taskId: pending.view.taskId });
  const taskId = core.nextId();
  const draft: MockFactDraft = {
    request,
    before: null,
    view: {
      taskId,
      status: "running",
      text: req.text,
      factRequestId: requestId,
      facts: [],
      version: null,
      previousVersion: null,
      notes: null,
      rejected: [],
      error: null,
      undone: false,
      undoable: false,
      retailor: null,
    },
  };
  drafts(core)[taskId] = draft;
  core.emit({ type: "task.started", taskId, runId: null, stepId: null, botName: "cv", kind: "fact_draft", engine: "claude", attempt: 1 });
  core.background(
    (async () => {
      await core.wait(MOCK_FACT_DRAFT_MS);
      settle(core, draft);
      core.emit({ type: "task.finished", taskId, runId: null, stepId: null, botName: "cv", status: "done", attempt: 1, error: null });
    })(),
  );
  return { taskId };
}

/** CV is done: the guard, then the facts go in as a new version (as the orchestrator's FactDraftStore). */
function settle(core: MockBackend, draft: MockFactDraft): void {
  const m = core.state.masterCv;
  if (m.kind !== "ok") {
    draft.view = { ...draft.view, status: "failed", error: "there is no master CV any more" };
    return;
  }
  const cv = m.cv;
  const out = mockDraftFacts(draft.view.text, draft.request, cv);
  const { accepted, rejected } = screenDraftedFacts(out.facts, {
    text: draft.view.text,
    question: draft.request,
    existingFacts: cv.facts,
  });
  if (accepted.length === 0) {
    draft.view = { ...draft.view, status: "no_facts", notes: out.notes, rejected };
    return;
  }
  const facts = withFreeFactIds(accepted.map(draftedToFact), cv.facts.map((f) => f.id));
  const next = MasterCvSchema.parse({ ...cv, version: cv.version + 1, facts: [...cv.facts, ...facts] });
  core.state.masterCv = { kind: "ok", cv: next };
  core.state.masterCvVersions.push({ version: next.version, savedAt: core.nowIso(), factCount: next.facts.length });
  if (draft.request) core.state.factRequests = core.state.factRequests.filter((r) => r.id !== draft.request!.id);
  draft.before = cv;
  draft.view = { ...draft.view, status: "added", facts, version: next.version, previousVersion: cv.version, notes: out.notes, rejected };
  core.emit({ type: "master_cv.updated", version: next.version, change: "facts_added", factIds: facts.map((f) => f.id), taskId: draft.view.taskId });
}

/** GET /master-cv/facts/draft/:taskId. */
export function readFactDraft(core: MockBackend, taskId: string): FactDraftView {
  const draft = drafts(core)[taskId];
  if (!draft) throw fail(404, "not_found", `there is no fact draft ${taskId}`);
  const m = core.state.masterCv;
  const added = draft.view.status === "added" && !draft.view.undone;
  return {
    ...draft.view,
    undoable: added && m.kind === "ok" && m.cv.version === draft.view.version,
    retailor: added && draft.request ? retailorFor(core, draft.request.jobId, draft.request.company) : null,
  };
}

/** POST /master-cv/facts/undo. */
export function undoFacts(core: MockBackend, body: unknown): MasterCv {
  const { version } = parseBody(FactUndoRequestSchema, body);
  const m = core.state.masterCv;
  if (m.kind !== "ok") throw fail(409, "conflict", "the master CV cannot be read, so nothing can be undone", { reason: m.kind === "missing" ? "master_cv_missing" : "master_cv_invalid" });
  if (m.cv.version !== version) {
    throw fail(409, "conflict", `only the latest change can be undone: the master CV is now version ${m.cv.version}`, { reason: "master_cv_changed", currentVersion: m.cv.version });
  }
  const draft = Object.values(drafts(core)).find((d) => d.view.status === "added" && d.view.version === version && !d.view.undone);
  if (!draft) throw fail(409, "conflict", `version ${version} did not add facts from your words, or it was already undone`, { reason: "not_undoable" });
  const ids = new Set(draft.view.facts.map((f) => f.id));
  const base = draft.before ?? { ...m.cv, facts: m.cv.facts.filter((f) => !ids.has(f.id)) };
  const restored = { ...structuredClone(base), version: m.cv.version + 1 };
  core.state.masterCv = { kind: "ok", cv: restored };
  core.state.masterCvVersions.push({ version: restored.version, savedAt: core.nowIso(), factCount: restored.facts.length });
  if (draft.request && !core.state.factRequests.some((r) => r.id === draft.request!.id)) core.state.factRequests = [...core.state.factRequests, draft.request];
  draft.view = { ...draft.view, undone: true };
  core.emit({ type: "master_cv.updated", version: restored.version, change: "undo", factIds: [...ids], taskId: draft.view.taskId });
  return restored;
}
