// DB rows → the shared domain types (packages/shared), for the API (Phase 3) and SSE.
// mappers.test.ts parses every mapped value with the shared Zod schema.
//
// Derivations (where a shared field has no column of its own):
// - ids: SQLite integers → decimal strings (shared `IdSchema` is an opaque string).
// - Job.company: the joined `companies.name`; null location / JD text → "" (not captured);
//   null fit reasons / gaps → [].
// - Step.branchKey: '' (run-level step, kept for the unique key) → null.
// - Task.pauseReason: the `code(site)` column parsed with `parsePauseReason` (detail null).
// - Message.author: 'ba' | 'system' | a bot name; Message.mode from the room kind
//   (lead → work, direct → consult, group → discussion); Message.uploadIds from
//   `uploads.message_id`; Message.cards from `meta_json.cards`.
// - Room.members: `room_members`.
// - SubmissionRecord: `submissions` + `job_snapshots` + the approval row (approvedAt =
//   approvals.created_at); consent / uploaded file are null when not captured; an
//   incomplete imported snapshot maps to null ("not captured").
// Columns the repositories always fill but SQLite allows NULL in (job language, CV
// tailored / frame name / versions, task prompt version) map to an invalid placeholder
// when NULL, so parsing with the shared schema fails loudly instead of guessing.
import {
  AppEventSchema,
  parsePauseReason,
  type AppEvent,
  type Application as SharedApplication,
  type ApprovalToken as SharedApprovalToken,
  type BotRecord as SharedBotRecord,
  type ChatMode,
  type Company as SharedCompany,
  type CvVersion as SharedCvVersion,
  type EngineState as SharedEngineState,
  type EventRecord as SharedEventRecord,
  type Export as SharedExport,
  type Job as SharedJob,
  type JobSnapshot as SharedJobSnapshot,
  type MemoryChange as SharedMemoryChange,
  type Message as SharedMessage,
  type MessageAuthor,
  type MessageCard,
  type PromptVersion as SharedPromptVersion,
  type QaReviewRecord as SharedQaReviewRecord,
  type Room as SharedRoom,
  type Run as SharedRun,
  type SavedAnswer as SharedSavedAnswer,
  type Schedule as SharedSchedule,
  type SearchProfile as SharedSearchProfile,
  type Step as SharedStep,
  type SubmissionRecord as SharedSubmissionRecord,
  type Task as SharedTask,
  type Upload as SharedUpload,
} from "@bs-job-agents/shared";
import type { RoomKind } from "./enums.js";
import type { EngineState } from "./repos/engine-state.js";
import type { FullSubmissionRecord } from "./repos/applications.js";
import type * as Row from "./types.js";

/** SQLite integer id → shared opaque string id. */
export const toId = (id: number): string => String(id);
const toIdOrNull = (id: number | null | undefined): string | null => (id === null || id === undefined ? null : toId(id));

export function toJob(row: Row.Job, company: Pick<Row.Company, "name">): SharedJob {
  return {
    id: toId(row.id),
    source: row.source,
    url: row.url,
    canonicalUrl: row.canonicalUrl,
    dedupeHash: row.dedupeHash,
    title: row.title,
    companyId: toId(row.companyId),
    company: company.name,
    location: row.location ?? "",
    workMode: row.workMode,
    salaryText: row.salaryText,
    language: row.language ?? "",
    jdText: row.jdText ?? "",
    fitScore: row.fitScore,
    fitReasons: row.fitReasons ?? [],
    gaps: row.gaps ?? [],
    status: row.status,
    skipReason: row.skipReason,
    skipNote: row.skipNote,
    injectionFlagged: row.injectionFlagged,
    injectionClearedAt: row.injectionClearedAt,
    firstSeenAt: row.firstSeenAt,
  };
}

export function toCompany(row: Row.Company): SharedCompany {
  return {
    id: toId(row.id),
    name: row.name,
    website: row.website,
    profile: row.profile,
    confidence: row.confidence,
    researchedAt: row.researchedAt,
  };
}

export function toCvVersion(row: Row.CvVersion): SharedCvVersion {
  return {
    id: toId(row.id),
    jobId: toId(row.jobId),
    language: row.language,
    round: row.round,
    tailored: row.tailored as SharedCvVersion["tailored"],
    figmaFrameName: row.figmaFrameName ?? "",
    figmaFrameUrl: row.figmaFrameUrl,
    pdfPath: row.pdfPath,
    pdfSha256: row.pdfSha256,
    changeNotes: row.changeNotes,
    factRequests: row.factRequests,
    masterVersion: row.masterVersion ?? 0,
    promptVersion: row.promptVersion ?? 0,
    createdAt: row.createdAt,
  };
}

export function toQaReview(row: Row.QaReview): SharedQaReviewRecord {
  return {
    id: toId(row.id),
    cvVersionId: toId(row.cvVersionId),
    total: row.total,
    scores: row.scores,
    hardFails: row.hardFails,
    fixes: row.fixes,
    injectionSuspected: row.injectionSuspected,
    passed: row.passed,
    createdAt: row.createdAt,
  };
}

export function toApprovalToken(row: Row.Approval): SharedApprovalToken {
  return {
    token: row.token,
    applicationId: toIdOrNull(row.applicationId),
    jobId: toId(row.jobId),
    cvVersionId: toId(row.cvVersionId),
    allowedDomains: row.allowedDomains,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    usedAt: row.usedAt,
  };
}

export function toApplication(row: Row.Application): SharedApplication {
  return {
    id: toId(row.id),
    jobId: toId(row.jobId),
    cvVersionId: toIdOrNull(row.cvVersionId),
    submittedAt: row.submittedAt,
    status: row.status,
    origin: row.origin,
    statusHistory: row.statusHistory.map((e) => ({ status: e.status, at: e.at, note: e.note ?? null })),
    dryRun: row.dryRun,
  };
}

/** The frozen posting, or null when an imported snapshot lacks its URL, title, company or text. */
export function toJobSnapshot(row: Row.JobSnapshot): SharedJobSnapshot | null {
  if (!row.url || !row.title || !row.company || !row.jdText) return null;
  return {
    applicationId: toId(row.applicationId),
    capturedAt: row.capturedAt,
    url: row.url,
    title: row.title,
    company: row.company,
    salaryText: row.salaryText,
    jdText: row.jdText,
    pageScreenshotPath: row.pageScreenshotPath,
  };
}

/** The Submission record panel (UC-13); null when nothing was recorded for the application. */
export function toSubmissionRecord(rec: FullSubmissionRecord): SharedSubmissionRecord | null {
  const s = rec.submission;
  if (!s) return null;
  return {
    applicationId: toId(rec.application.id),
    finalUrl: s.finalUrl,
    fields: s.fields,
    introText: s.introText,
    consent: s.consentTicked === null ? null : { ticked: s.consentTicked, text: s.consentText },
    uploadedFile: s.uploadedFilename ? { filename: s.uploadedFilename, sha256: s.uploadedSha256, path: s.uploadedPath } : null,
    preSubmitScreenshotPath: s.preSubmitScreenshotPath,
    confirmationScreenshotPath: s.confirmationScreenshotPath,
    confirmationText: s.confirmationText,
    approvalToken: s.approvalToken,
    approval: rec.approval
      ? {
          approvedAt: rec.approval.createdAt,
          cvVersionId: toId(rec.approval.cvVersionId),
          allowedDomains: rec.approval.allowedDomains,
          note: null,
        }
      : null,
    submittedAt: s.submittedAt,
    jdSnapshot: rec.snapshot ? toJobSnapshot(rec.snapshot) : null,
    dryRun: s.dryRun,
  };
}

export function toRun(row: Row.Run): SharedRun {
  return {
    id: toId(row.id),
    workflowName: row.workflowName,
    workflowVersion: row.workflowVersion,
    trigger: row.trigger,
    params: row.params,
    searchProfileVersion: row.searchProfileVersion,
    scheduleId: toIdOrNull(row.scheduleId),
    status: row.status,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  };
}

export function toStep(row: Row.Step): SharedStep {
  return {
    id: toId(row.id),
    runId: toId(row.runId),
    stepKey: row.stepKey,
    branchKey: row.branchKey === "" ? null : row.branchKey,
    status: row.status,
    round: row.round,
    output: row.output ?? null,
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

export function toTask(row: Row.Task): SharedTask {
  return {
    id: toId(row.id),
    runId: toIdOrNull(row.runId),
    stepId: toIdOrNull(row.stepId),
    botName: row.botName,
    kind: row.kind,
    input: row.input,
    output: row.output ?? null,
    status: row.status,
    pauseReason: row.pauseReason ? parsePauseReason(row.pauseReason) : null,
    attempt: row.attempt,
    engine: row.engine,
    promptVersion: row.promptVersion ?? 0,
    transcriptPath: row.transcriptPath,
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

export function toSearchProfile(row: Row.SearchProfile): SharedSearchProfile {
  return {
    id: toId(row.id),
    name: row.name,
    version: row.version,
    active: row.active,
    roles: row.roles,
    locations: row.locations,
    workModes: row.workModes,
    minSalary: row.minSalary,
    currency: row.currency,
    seniority: row.seniority,
    sources: row.sources,
    includeKeywords: row.includeKeywords,
    excludeKeywords: row.excludeKeywords,
    excludeCompanies: row.excludeCompanies,
    companyTypes: row.companyTypes,
    languages: row.languages,
    maxJobs: row.maxJobs,
    fitThreshold: row.fitThreshold,
    salaryPolicy: row.salaryPolicy,
    salaryAmount: row.salaryAmount,
    updatedAt: row.updatedAt,
  };
}

export function toSchedule(row: Row.Schedule): SharedSchedule {
  return {
    id: toId(row.id),
    name: row.name,
    cron: row.cron,
    timezone: row.timezone,
    workflowName: row.workflowName,
    searchProfileId: toIdOrNull(row.searchProfileId),
    params: row.params,
    enabled: row.enabled,
    lastRunId: toIdOrNull(row.lastRunId),
    nextRunAt: row.nextRunAt,
    deletedAt: row.deletedAt,
  };
}

export function toEngineState(row: EngineState): SharedEngineState {
  return { engine: row.engine, pausedUntil: row.pausedUntil, reason: row.reason };
}

export function toRoom(row: Row.Room, members: readonly string[]): SharedRoom {
  return {
    id: toId(row.id),
    name: row.name,
    kind: row.kind,
    botName: row.botName,
    members: [...members],
    createdAt: row.createdAt,
  };
}

/** Lead chat = work (may start work); direct thread = consult (UC-25); room = discussion (UC-15). */
export const CHAT_MODE_BY_ROOM_KIND = {
  lead: "work",
  direct: "consult",
  group: "discussion",
} as const satisfies Record<RoomKind, ChatMode>;

function toAuthor(author: string): MessageAuthor {
  if (author === "ba") return { type: "ba" };
  if (author === "system") return { type: "system" };
  return { type: "bot", bot: author };
}

export function toMessage(row: Row.Message, roomKind: RoomKind, uploadIds: readonly number[]): SharedMessage {
  const cards = (row.meta?.cards as MessageCard[] | undefined) ?? [];
  return {
    id: toId(row.id),
    roomId: toId(row.roomId),
    author: toAuthor(row.author),
    text: row.text,
    mode: CHAT_MODE_BY_ROOM_KIND[roomKind],
    mentions: row.mentions,
    runIds: row.runRefs.map(toId),
    uploadIds: uploadIds.map(toId),
    cards,
    createdAt: row.createdAt,
  };
}

export function toUpload(row: Row.Upload): SharedUpload {
  return {
    id: toId(row.id),
    filename: row.filename,
    mime: row.mime as SharedUpload["mime"],
    size: row.size,
    path: row.path,
    sha256: row.sha256,
    uploadedAt: row.uploadedAt,
    messageId: toIdOrNull(row.messageId),
  };
}

export function toExport(row: Row.ExportRecord): SharedExport {
  return { id: toId(row.id), createdAt: row.createdAt, path: row.path, applicationCount: row.applicationCount };
}

export function toSavedAnswer(row: Row.SavedAnswer): SharedSavedAnswer {
  return { key: row.key, label: row.label, answer: row.answer, updatedAt: row.updatedAt };
}

export function toBotRecord(row: Row.Bot): SharedBotRecord {
  return {
    name: row.name,
    displayName: row.displayName,
    engine: row.engine,
    model: row.model,
    trustLevel: row.trustLevel as SharedBotRecord["trustLevel"],
    promptVersion: row.promptVersion,
    enabled: row.enabled,
  };
}

export function toPromptVersion(row: Row.PromptVersion): SharedPromptVersion {
  return {
    id: toId(row.id),
    botName: row.botName,
    version: row.version,
    roleMdHash: row.roleMdHash,
    roleMdText: row.roleMdText,
    createdAt: row.createdAt,
  };
}

export function toMemoryChange(row: Row.MemoryChange): SharedMemoryChange {
  return {
    id: toId(row.id),
    botName: row.botName,
    runId: toIdOrNull(row.runId),
    taskId: toIdOrNull(row.taskId),
    note: row.note,
    createdAt: row.createdAt,
  };
}

export function toEventRecord(row: Row.EventRow): SharedEventRecord {
  return { id: toId(row.id), type: row.type, payload: row.payload, createdAt: row.createdAt };
}

/** Replay a row as the SSE event it was stored from (appendAppEvent); null for audit-only rows. */
export function toAppEvent(row: Row.EventRow): AppEvent | null {
  const parsed = AppEventSchema.safeParse({ ...row.payload, id: toId(row.id), at: row.createdAt, type: row.type });
  return parsed.success ? parsed.data : null;
}
