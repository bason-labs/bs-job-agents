// Drizzle schema for data/app.db (spec §9, §9.1).
//
// Conventions:
// - SQL column names are exactly the §9 names. JSON columns keep the `_json`
//   suffix in SQL; their TypeScript property drops it (`params_json` → `params`)
//   because Drizzle parses them.
// - Timestamps are ISO-8601 UTC strings (`2026-10-10T08:40:00.000Z`), which sort
//   lexicographically and map to `z.string().datetime()`.
// - Ids are integer autoincrement, except `bots.name`, `approvals.token`,
//   `saved_answers.key` and `engine_state.engine` (text keys per §9).
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import {
  DEFAULT_TIMEZONE,
  type CompanyProfile,
  type CvLanguage,
  type FactRequest,
  type QaFix,
  type QaHardFail,
  type QaScores,
  type SearchSource,
  type Seniority,
  type StatusHistoryEntry,
  type SubmittedField,
  type TailoredCv,
  type WorkMode,
} from "@bs-job-agents/shared";
import {
  APPLICATION_ORIGINS,
  APPLICATION_STATUSES,
  COMPANY_CONFIDENCE,
  CURRENCIES,
  CV_LANGUAGES,
  ENGINE_PAUSE_REASONS,
  ENGINES,
  JOB_STATUSES,
  ROOM_KINDS,
  RUN_STATUSES,
  RUN_TRIGGERS,
  SALARY_POLICIES,
  SKIP_REASONS,
  STEP_STATUSES,
  TASK_STATUSES,
  TRUST_LEVELS,
  WORK_MODES,
} from "./enums.js";

/** `CHECK (<column> IN ('a','b'))`, nullable columns pass when NULL. */
function oneOf(name: string, column: string, values: readonly (string | number)[]): ReturnType<typeof check> {
  const list = values.map((v) => (typeof v === "number" ? String(v) : `'${v}'`)).join(", ");
  return check(name, sql.raw(`"${column}" IS NULL OR "${column}" IN (${list})`));
}

const createdAt = () => text("created_at").notNull();
const boolCol = (name: string) => integer(name, { mode: "boolean" });

// ---------------------------------------------------------------------------
// JSON column payload types: the shared Zod types (packages/shared) where one exists.

export type JsonObject = Record<string, unknown>;
export type { StatusHistoryEntry, SubmittedField };

// ---------------------------------------------------------------------------
// Bots, prompts, memory, workflows

export const bots = sqliteTable(
  "bots",
  {
    name: text("name").primaryKey(),
    displayName: text("display_name").notNull(),
    engine: text("engine", { enum: ENGINES }).notNull(),
    model: text("model"),
    trustLevel: integer("trust_level").notNull(),
    promptVersion: integer("prompt_version").notNull().default(1),
    enabled: boolCol("enabled").notNull().default(true),
  },
  () => [
    oneOf("bots_engine_check", "engine", ENGINES),
    oneOf("bots_trust_level_check", "trust_level", TRUST_LEVELS),
  ],
);

export const promptVersions = sqliteTable(
  "prompt_versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    botName: text("bot_name")
      .notNull()
      .references(() => bots.name),
    version: integer("version").notNull(),
    roleMdHash: text("role_md_hash").notNull(),
    roleMdText: text("role_md_text").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("prompt_versions_bot_version_uq").on(t.botName, t.version)],
);

export const memoryChanges = sqliteTable(
  "memory_changes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    botName: text("bot_name")
      .notNull()
      .references(() => bots.name),
    runId: integer("run_id").references(() => runs.id, { onDelete: "set null" }),
    taskId: integer("task_id").references(() => tasks.id, { onDelete: "set null" }),
    note: text("note").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("memory_changes_bot_idx").on(t.botName, t.createdAt)],
);

/**
 * PM2 S8 (§5.3): automatic demotions, one level per violation. `restored_at` is set when Ba
 * raises the bot back to `from_level` (Bots screen) or says a protected-page change was his.
 */
export const botDemotions = sqliteTable(
  "bot_demotions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    botName: text("bot_name")
      .notNull()
      .references(() => bots.name),
    fromLevel: integer("from_level").notNull(),
    toLevel: integer("to_level").notNull(),
    /** A SafetyDenialReason, or "qa_hard_fail". */
    reason: text("reason").notNull(),
    detail: text("detail"),
    runId: integer("run_id").references(() => runs.id, { onDelete: "set null" }),
    taskId: integer("task_id").references(() => tasks.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    restoredAt: text("restored_at"),
  },
  (t) => [index("bot_demotions_bot_idx").on(t.botName, t.createdAt)],
);

export const workflows = sqliteTable(
  "workflows",
  {
    name: text("name").notNull(),
    version: integer("version").notNull(),
    definitionYaml: text("definition_yaml").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.name, t.version] })],
);

// ---------------------------------------------------------------------------
// Runs, steps, tasks

export const runs = sqliteTable(
  "runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    workflowName: text("workflow_name").notNull(),
    workflowVersion: integer("workflow_version").notNull(),
    trigger: text("trigger", { enum: RUN_TRIGGERS }).notNull(),
    params: text("params_json", { mode: "json" }).$type<JsonObject>().notNull(),
    status: text("status", { enum: RUN_STATUSES }).notNull().default("running"),
    // Extra (not in §9): the Search Profile version the run started with (UC-21b).
    searchProfileVersion: integer("search_profile_version"),
    // Extra (not in §9): which schedule fired this run, for overlap checks (UC-02a).
    scheduleId: integer("schedule_id").references((): AnySQLiteColumn => schedules.id, {
      onDelete: "set null",
    }),
    // Extra (not in §9): short failure summary for the run card.
    error: text("error"),
    createdAt: createdAt(),
    finishedAt: text("finished_at"),
    // Extra (not in §9, Phase 2): the Search Profile version row the run started with, so it
    // keeps that version after later edits (UC-21b). Added with ADD COLUMN (0006).
    searchProfileId: integer("search_profile_id").references((): AnySQLiteColumn => searchProfiles.id),
  },
  (t) => [
    oneOf("runs_trigger_check", "trigger", RUN_TRIGGERS),
    oneOf("runs_status_check", "status", RUN_STATUSES),
    index("runs_status_idx").on(t.status),
    index("runs_schedule_idx").on(t.scheduleId),
    index("runs_created_idx").on(t.createdAt),
  ],
);

export const steps = sqliteTable(
  "steps",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: integer("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    stepKey: text("step_key").notNull(),
    // Job id for per-job branches; '' for run-level steps (so the unique key works).
    branchKey: text("branch_key").notNull().default(""),
    status: text("status", { enum: STEP_STATUSES }).notNull().default("pending"),
    // Extra (not in §9): gate round 1..maxRounds (§7.2 step 7).
    round: integer("round"),
    output: text("output_json", { mode: "json" }).$type<unknown>(),
    error: text("error"),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
  },
  (t) => [
    oneOf("steps_status_check", "status", STEP_STATUSES),
    uniqueIndex("steps_run_key_branch_uq").on(t.runId, t.stepKey, t.branchKey),
  ],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // NULL for consult (UC-25) and room discussion (UC-15) tasks, which run outside a
    // workflow but still go through the queue and its caps (§10.3).
    runId: integer("run_id").references(() => runs.id, { onDelete: "cascade" }),
    stepId: integer("step_id").references(() => steps.id, { onDelete: "cascade" }),
    botName: text("bot_name").notNull(),
    kind: text("kind").notNull(),
    input: text("input_json", { mode: "json" }).$type<unknown>().notNull(),
    output: text("output_json", { mode: "json" }).$type<unknown>(),
    status: text("status", { enum: TASK_STATUSES }).notNull().default("queued"),
    pauseReason: text("pause_reason"),
    attempt: integer("attempt").notNull().default(1),
    engine: text("engine", { enum: ENGINES }).notNull(),
    promptVersion: integer("prompt_version"),
    transcriptPath: text("transcript_path"),
    // Extras (not in §9): lock needs for the claim filter (§10.3) and a failure note.
    usesBrowser: boolCol("uses_browser").notNull().default(false),
    usesFigma: boolCol("uses_figma").notNull().default(false),
    error: text("error"),
    createdAt: createdAt(),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
  },
  (t) => [
    oneOf("tasks_status_check", "status", TASK_STATUSES),
    oneOf("tasks_engine_check", "engine", ENGINES),
    index("tasks_status_idx").on(t.status, t.engine, t.createdAt),
    index("tasks_run_idx").on(t.runId),
    index("tasks_step_idx").on(t.stepId),
  ],
);

// ---------------------------------------------------------------------------
// Jobs, companies, CVs, QA

export const companies = sqliteTable(
  "companies",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    // Extra (not in §9): normalised name used for lookups and dedupe.
    nameKey: text("name_key").notNull(),
    website: text("website"),
    profile: text("profile_json", { mode: "json" }).$type<CompanyProfile>(),
    confidence: text("confidence", { enum: COMPANY_CONFIDENCE }),
    researchedAt: text("researched_at"),
  },
  (t) => [
    oneOf("companies_confidence_check", "confidence", COMPANY_CONFIDENCE),
    uniqueIndex("companies_name_key_uq").on(t.nameKey),
  ],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    source: text("source").notNull(),
    // NULL only for an uploaded JD whose posting was not found (§7.3b "no apply link found").
    url: text("url"),
    canonicalUrl: text("canonical_url"),
    dedupeHash: text("dedupe_hash").notNull(),
    title: text("title").notNull(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id),
    location: text("location"),
    // Extra (not in §9): JobCandidate.workMode (§7.5 work modes).
    workMode: text("work_mode", { enum: WORK_MODES }),
    salaryText: text("salary_text"),
    language: text("language"),
    jdText: text("jd_text"),
    fitScore: integer("fit_score"),
    fitReasons: text("fit_reasons_json", { mode: "json" }).$type<string[]>(),
    gaps: text("gaps_json", { mode: "json" }).$type<string[]>(),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("new"),
    skipReason: text("skip_reason", { enum: SKIP_REASONS }),
    skipNote: text("skip_note"),
    // Extra (not in §9): JobCandidate.postedAt (UC-03).
    postedAt: text("posted_at"),
    // Extras (not in §9), UC-07 b / §10.2 rule 4: QA suspected prompt injection, and
    // when Ba confirmed the job is safe. Apply is blocked while flagged and not cleared.
    injectionFlagged: boolCol("injection_flagged").notNull().default(false),
    injectionClearedAt: text("injection_cleared_at"),
    firstSeenAt: text("first_seen_at").notNull(),
  },
  (t) => [
    oneOf("jobs_status_check", "status", JOB_STATUSES),
    oneOf("jobs_skip_reason_check", "skip_reason", SKIP_REASONS),
    oneOf("jobs_work_mode_check", "work_mode", WORK_MODES),
    check("jobs_fit_score_check", sql.raw(`"fit_score" IS NULL OR ("fit_score" BETWEEN 0 AND 100)`)),
    uniqueIndex("jobs_canonical_url_uq").on(t.canonicalUrl),
    uniqueIndex("jobs_dedupe_hash_uq").on(t.dedupeHash),
    index("jobs_status_idx").on(t.status),
    index("jobs_company_idx").on(t.companyId),
  ],
);

export const cvVersions = sqliteTable(
  "cv_versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: integer("job_id")
      .notNull()
      .references(() => jobs.id),
    language: text("language", { enum: CV_LANGUAGES }).notNull(),
    round: integer("round").notNull(),
    tailored: text("tailored_json", { mode: "json" }).$type<TailoredCv>(),
    // Extra (not in §9): Drafts frame `<COMPANY>_<ROLE>_<LANG>_v<n>`; the PDF is data/pdf/<name>.pdf (§6.2).
    figmaFrameName: text("figma_frame_name"),
    figmaFrameUrl: text("figma_frame_url"),
    pdfPath: text("pdf_path"),
    // Extra (not in §9): SHA-256 of the exported PDF, checked before upload (§9.1).
    pdfSha256: text("pdf_sha256"),
    // Extras (not in §9): CvDraft.changeNotes and factRequests (§5.2 CV, §6.1).
    changeNotes: text("change_notes_json", { mode: "json" }).$type<string[]>().notNull().default([]),
    factRequests: text("fact_requests_json", { mode: "json" }).$type<FactRequest[]>().notNull().default([]),
    masterVersion: integer("master_version"),
    promptVersion: integer("prompt_version"),
    createdAt: createdAt(),
  },
  (t) => [
    oneOf("cv_versions_language_check", "language", CV_LANGUAGES),
    index("cv_versions_job_idx").on(t.jobId, t.language, t.round),
  ],
);

export const qaReviews = sqliteTable(
  "qa_reviews",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    cvVersionId: integer("cv_version_id")
      .notNull()
      .references(() => cvVersions.id),
    total: integer("total").notNull(),
    scores: text("scores_json", { mode: "json" }).$type<QaScores>().notNull(),
    hardFails: text("hard_fails_json", { mode: "json" }).$type<QaHardFail[]>().notNull(),
    fixes: text("fixes_json", { mode: "json" }).$type<QaFix[]>().notNull(),
    injectionSuspected: boolCol("injection_suspected").notNull().default(false),
    passed: boolCol("passed").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("qa_reviews_cv_idx").on(t.cvVersionId)],
);

// ---------------------------------------------------------------------------
// Approvals, applications, submission record (§9.1)

export const approvals = sqliteTable(
  "approvals",
  {
    token: text("token").primaryKey(),
    jobId: integer("job_id")
      .notNull()
      .references(() => jobs.id),
    cvVersionId: integer("cv_version_id")
      .notNull()
      .references(() => cvVersions.id),
    allowedDomains: text("allowed_domains_json", { mode: "json" }).$type<string[]>().notNull(),
    expiresAt: text("expires_at").notNull(),
    usedAt: text("used_at"),
    // Extra (not in §9): approval time, shown in the submission record (UC-13).
    createdAt: createdAt(),
    // Extra (not in §9, PM M2): the one application this token authorises, set when it is
    // created (UC-08). NULL only for tokens issued before 0004 that no record cites; those
    // cannot start or resume Apply. Added with ADD COLUMN: never rebuild this table.
    applicationId: integer("application_id").references((): AnySQLiteColumn => applications.id),
  },
  (t) => [index("approvals_job_idx").on(t.jobId), index("approvals_application_idx").on(t.applicationId)],
);

export const applications = sqliteTable(
  "applications",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: integer("job_id")
      .notNull()
      .references(() => jobs.id),
    cvVersionId: integer("cv_version_id").references(() => cvVersions.id),
    submittedAt: text("submitted_at"),
    status: text("status", { enum: APPLICATION_STATUSES }).notNull(),
    origin: text("origin", { enum: APPLICATION_ORIGINS }).notNull().default("app"),
    statusHistory: text("status_history_json", { mode: "json" })
      .$type<StatusHistoryEntry[]>()
      .notNull(),
    // Extra (not in §9): explicit "apply again" (§10.2 rule 5) lifts the one-per-job rule.
    reapply: boolCol("reapply").notNull().default(false),
    createdAt: createdAt(),
    // Extra (not in §9, PM M3): a dry-run acceptance run (§12) fills the form and never clicks
    // submit. It never counts toward the one-per-job rule and never reaches `submitted`
    // (repository + triggers in 0003). Added with ADD COLUMN: never rebuild this table.
    dryRun: boolCol("dry_run").notNull().default(false),
  },
  (t) => [
    oneOf("applications_status_check", "status", APPLICATION_STATUSES),
    oneOf("applications_origin_check", "origin", APPLICATION_ORIGINS),
    // §10.2 rule 5: one application per job unless explicitly re-applied; dry runs never count.
    uniqueIndex("applications_job_uq").on(t.jobId).where(sql`"reapply" = 0 AND "dry_run" = 0`),
    index("applications_status_idx").on(t.status),
  ],
);

export const submissions = sqliteTable("submissions", {
  applicationId: integer("application_id")
    .primaryKey()
    .references(() => applications.id),
  finalUrl: text("final_url"),
  fields: text("fields_json", { mode: "json" }).$type<SubmittedField[]>().notNull(),
  introText: text("intro_text"),
  consentTicked: boolCol("consent_ticked"),
  consentText: text("consent_text"),
  uploadedFilename: text("uploaded_filename"),
  uploadedSha256: text("uploaded_sha256"),
  uploadedPath: text("uploaded_path"),
  preSubmitScreenshotPath: text("pre_submit_screenshot_path"),
  confirmationScreenshotPath: text("confirmation_screenshot_path"),
  confirmationText: text("confirmation_text"),
  approvalToken: text("approval_token").references(() => approvals.token),
  submittedAt: text("submitted_at"),
  // Extra (not in §9): dry-run acceptance (§12) filled the form but never clicked submit;
  // its application is `needs_check` (coordinator decision, Phase 1 QA).
  dryRun: boolCol("dry_run").notNull().default(false),
});

export const jobSnapshots = sqliteTable("job_snapshots", {
  applicationId: integer("application_id")
    .primaryKey()
    .references(() => applications.id),
  capturedAt: text("captured_at").notNull(),
  url: text("url"),
  title: text("title"),
  company: text("company"),
  salaryText: text("salary_text"),
  jdText: text("jd_text"),
  pageScreenshotPath: text("page_screenshot_path"),
});

export const exports = sqliteTable("exports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  createdAt: createdAt(),
  path: text("path").notNull(),
  applicationCount: integer("application_count").notNull(),
});

export const savedAnswers = sqliteTable("saved_answers", {
  key: text("key").primaryKey(),
  label: text("label").notNull(),
  answer: text("answer").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ---------------------------------------------------------------------------
// Chat: rooms, members, messages, uploads

export const rooms = sqliteTable(
  "rooms",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    // Extra (not in §9): lead chat, direct consult-mode thread (UC-25) or group room (UC-15).
    kind: text("kind", { enum: ROOM_KINDS }).notNull(),
    // Lead and direct rooms: the bot Ba is talking to.
    botName: text("bot_name").references(() => bots.name),
    createdAt: createdAt(),
  },
  (t) => [
    oneOf("rooms_kind_check", "kind", ROOM_KINDS),
    uniqueIndex("rooms_name_uq").on(t.name),
    uniqueIndex("rooms_direct_bot_uq").on(t.botName).where(sql`"kind" = 'direct'`),
    uniqueIndex("rooms_single_lead_uq").on(t.kind).where(sql`"kind" = 'lead'`),
  ],
);

export const roomMembers = sqliteTable(
  "room_members",
  {
    roomId: integer("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    botName: text("bot_name")
      .notNull()
      .references(() => bots.name),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.botName] })],
);

export const messages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    roomId: integer("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    // 'ba' or a bot name.
    author: text("author").notNull(),
    text: text("text").notNull(),
    mentions: text("mentions_json", { mode: "json" }).$type<string[]>().notNull(),
    runRefs: text("run_refs_json", { mode: "json" }).$type<number[]>().notNull(),
    // Free-form extras: handoff note (UC-25a), card payloads, consult flag.
    meta: text("meta_json", { mode: "json" }).$type<JsonObject>(),
    createdAt: createdAt(),
  },
  (t) => [index("messages_room_idx").on(t.roomId, t.id)],
);

export const uploads = sqliteTable(
  "uploads",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    path: text("path").notNull(),
    sha256: text("sha256").notNull(),
    uploadedAt: text("uploaded_at").notNull(),
    messageId: integer("message_id").references(() => messages.id, { onDelete: "set null" }),
  },
  (t) => [index("uploads_message_idx").on(t.messageId)],
);

// ---------------------------------------------------------------------------
// Search profiles, schedules

export const searchProfiles = sqliteTable(
  "search_profiles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // Versions of one profile share a name; each row is one version (UC-21b).
    name: text("name").notNull(),
    version: integer("version").notNull(),
    active: boolCol("active").notNull().default(false),
    roles: text("roles_json", { mode: "json" }).$type<string[]>().notNull(),
    locations: text("locations_json", { mode: "json" }).$type<string[]>().notNull(),
    workModes: text("work_modes_json", { mode: "json" }).$type<WorkMode[]>().notNull(),
    minSalary: real("min_salary"),
    currency: text("currency", { enum: CURRENCIES }),
    seniority: text("seniority_json", { mode: "json" }).$type<Seniority[]>().notNull(),
    sources: text("sources_json", { mode: "json" }).$type<SearchSource[]>().notNull(),
    includeKeywords: text("include_keywords_json", { mode: "json" }).$type<string[]>().notNull(),
    excludeKeywords: text("exclude_keywords_json", { mode: "json" }).$type<string[]>().notNull(),
    excludeCompanies: text("exclude_companies_json", { mode: "json" }).$type<string[]>().notNull(),
    companyTypes: text("company_types_json", { mode: "json" }).$type<string[]>().notNull(),
    languages: text("languages_json", { mode: "json" }).$type<CvLanguage[]>().notNull(),
    maxJobs: integer("max_jobs").notNull().default(5),
    fitThreshold: integer("fit_threshold").notNull().default(60),
    salaryPolicy: text("salary_policy", { enum: SALARY_POLICIES })
      .notNull()
      .default("blank_if_optional"),
    salaryAmount: real("salary_amount"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    oneOf("search_profiles_currency_check", "currency", CURRENCIES),
    oneOf("search_profiles_salary_policy_check", "salary_policy", SALARY_POLICIES),
    uniqueIndex("search_profiles_name_version_uq").on(t.name, t.version),
    // One active profile version at a time (§7.5).
    uniqueIndex("search_profiles_single_active_uq").on(t.active).where(sql`"active" = 1`),
  ],
);

export const schedules = sqliteTable(
  "schedules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    cron: text("cron").notNull(),
    // Extra (not in §9): the cron's time zone (§11 Schedules: Asia/Ho_Chi_Minh).
    timezone: text("timezone").notNull().default(DEFAULT_TIMEZONE),
    workflowName: text("workflow_name").notNull(),
    // NULL = use the active Search Profile (UC-21 default).
    searchProfileId: integer("search_profile_id").references(() => searchProfiles.id),
    params: text("params_json", { mode: "json" }).$type<JsonObject>().notNull(),
    enabled: boolCol("enabled").notNull().default(true),
    lastRunId: integer("last_run_id").references((): AnySQLiteColumn => runs.id, {
      onDelete: "set null",
    }),
    nextRunAt: text("next_run_at"),
    deletedAt: text("deleted_at"),
    // Extra (not in §9): audit timestamps.
    createdAt: createdAt(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("schedules_deleted_idx").on(t.deletedAt)],
);

// ---------------------------------------------------------------------------
// Engine state, events

export const engineState = sqliteTable(
  "engine_state",
  {
    engine: text("engine", { enum: ENGINES }).primaryKey(),
    pausedUntil: text("paused_until"),
    reason: text("reason", { enum: ENGINE_PAUSE_REASONS }),
  },
  () => [
    oneOf("engine_state_engine_check", "engine", ENGINES),
    oneOf("engine_state_reason_check", "reason", ENGINE_PAUSE_REASONS),
  ],
);

export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type").notNull(),
    payload: text("payload_json", { mode: "json" }).$type<JsonObject>().notNull(),
    // Extras (not in §9): query an audit trail by run / task (UC-22, SSE replay).
    runId: integer("run_id"),
    taskId: integer("task_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("events_run_idx").on(t.runId, t.id),
    index("events_type_idx").on(t.type),
  ],
);
