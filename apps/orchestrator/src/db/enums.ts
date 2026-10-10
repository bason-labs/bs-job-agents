// Enum values stored in SQLite (spec §9). The single source of truth is the shared
// Zod schemas in @bs-job-agents/shared; the lists here are derived from them and
// feed the Drizzle column types and the CHECK constraints in the migrations.
// enums.test.ts fails if the live SQLite CHECK constraints drift from shared.
import {
  APPLICATION_STATUSES,
  ApplicationOriginSchema,
  CompanyConfidenceSchema,
  CurrencySchema,
  CvLanguageSchema,
  EnginePauseReasonSchema,
  EngineSchema,
  FieldSourceSchema,
  JOB_STATUSES,
  PAUSE_REASON_CODES,
  RoomKindSchema,
  RUN_STATUSES,
  RunTriggerSchema,
  SKIP_REASONS,
  STEP_STATUSES,
  SalaryPolicySchema,
  TASK_STATUSES,
  TRUST_LEVEL_LABELS,
  WorkModeSchema,
  type ApplicationStatus,
  type RunStatus,
  type StepStatus,
  type TaskStatus,
  type TrustLevel,
} from "@bs-job-agents/shared";

export type {
  ApplicationOrigin,
  ApplicationStatus,
  CompanyConfidence,
  Currency,
  CvLanguage,
  Engine,
  FieldSource,
  JobStatus,
  PauseReasonCode,
  RoomKind,
  RunStatus,
  RunTrigger,
  SalaryPolicy,
  SkipReason,
  StepStatus,
  TaskStatus,
  TrustLevel,
  WorkMode,
} from "@bs-job-agents/shared";
export type EnginePauseReason = (typeof ENGINE_PAUSE_REASONS)[number];

export const ENGINES = EngineSchema.options;
export const RUN_TRIGGERS = RunTriggerSchema.options;
export { RUN_STATUSES, STEP_STATUSES, TASK_STATUSES, JOB_STATUSES, SKIP_REASONS, APPLICATION_STATUSES, PAUSE_REASON_CODES };
export const CV_LANGUAGES = CvLanguageSchema.options;
export const WORK_MODES = WorkModeSchema.options;
export const COMPANY_CONFIDENCE = CompanyConfidenceSchema.options;
export const APPLICATION_ORIGINS = ApplicationOriginSchema.options;
export const FIELD_SOURCES = FieldSourceSchema.options;
export const SALARY_POLICIES = SalaryPolicySchema.options;
export const CURRENCIES = CurrencySchema.options;
/** lead = the Lead chat; direct = a 1:1 consult-mode thread (UC-25); group = a room (UC-15). */
export const ROOM_KINDS = RoomKindSchema.options;
export const ENGINE_PAUSE_REASONS = EnginePauseReasonSchema.options;
export const TRUST_LEVELS = Object.keys(TRUST_LEVEL_LABELS).map(Number) as TrustLevel[];

export const TERMINAL_RUN_STATUSES = ["done", "failed", "cancelled"] as const satisfies readonly RunStatus[];
export const ACTIVE_RUN_STATUSES = ["running", "waiting", "paused"] as const satisfies readonly RunStatus[];
export const TERMINAL_STEP_STATUSES = ["done", "failed", "skipped", "cancelled"] as const satisfies readonly StepStatus[];
export const TERMINAL_TASK_STATUSES = ["done", "failed"] as const satisfies readonly TaskStatus[];
/** Statuses an Apply run ends in before Ba tracks it by hand (UC-11). */
export const APPLY_OUTCOME_STATUSES = ["submitted", "needs_check"] as const satisfies readonly ApplicationStatus[];
