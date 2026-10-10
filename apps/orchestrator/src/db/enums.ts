// Enum values stored in SQLite (spec §9). W1a's shared Zod enums should use the
// same literals; once packages/shared exports them, these can be re-exported.

export const ENGINES = ["claude", "codex"] as const;
export type Engine = (typeof ENGINES)[number];

export const RUN_TRIGGERS = ["chat", "schedule", "link"] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export const RUN_STATUSES = ["running", "waiting", "paused", "done", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const TERMINAL_RUN_STATUSES = ["done", "failed", "cancelled"] as const;
export const ACTIVE_RUN_STATUSES = ["running", "waiting", "paused"] as const;

// §9 leaves step statuses open; these mirror the Flow canvas node states (§11).
export const STEP_STATUSES = [
  "pending",
  "running",
  "waiting",
  "done",
  "failed",
  "skipped",
  "cancelled",
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];
export const TERMINAL_STEP_STATUSES = ["done", "failed", "skipped", "cancelled"] as const;

export const TASK_STATUSES = [
  "queued",
  "running",
  "waiting_limit",
  "paused",
  "done",
  "failed",
  "interrupted",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TERMINAL_TASK_STATUSES = ["done", "failed"] as const;

export const JOB_STATUSES = [
  "new",
  "below_threshold",
  "selected",
  "reviewing",
  "approved",
  "applied",
  "skipped",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

// UC-10
export const SKIP_REASONS = [
  "salary_low",
  "outsourcing",
  "location",
  "tech_mismatch",
  "company_culture",
  "seniority",
  "other",
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export const CV_LANGUAGES = ["EN", "VI"] as const;
export type CvLanguage = (typeof CV_LANGUAGES)[number];

// UC-05(b)
export const COMPANY_CONFIDENCE = ["normal", "low_confidence"] as const;
export type CompanyConfidence = (typeof COMPANY_CONFIDENCE)[number];

// UC-08 (approved), UC-11 (paused / submitted / needs_check), UC-11(c) (failed),
// UC-13 (interviewing / offer / rejected / withdrawn / no_response).
export const APPLICATION_STATUSES = [
  "approved",
  "paused",
  "submitted",
  "needs_check",
  "failed",
  "interviewing",
  "offer",
  "rejected",
  "withdrawn",
  "no_response",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const APPLICATION_ORIGINS = ["app", "imported"] as const;
export type ApplicationOrigin = (typeof APPLICATION_ORIGINS)[number];

// ApplyResult.fieldsFilled[].source (§5.2 Apply)
export const FIELD_SOURCES = [
  "master_cv",
  "saved_answer",
  "ba_answer",
  "search_profile",
  "form_defaults",
  "generated",
  "skipped",
] as const;
export type FieldSource = (typeof FIELD_SOURCES)[number];

// §7.5 Application form defaults: expected salary rule (prototype literals).
export const SALARY_POLICIES = ["blank_if_optional", "negotiable", "fixed", "ask"] as const;
export type SalaryPolicy = (typeof SALARY_POLICIES)[number];

export const CURRENCIES = ["VND", "USD"] as const;
export type Currency = (typeof CURRENCIES)[number];

export const ROOM_KINDS = ["lead", "consult", "group"] as const;
export type RoomKind = (typeof ROOM_KINDS)[number];

export const TRUST_LEVELS = [0, 1, 2] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];
