// What the engine persists in `steps.output_json` while a step runs and when it finishes. A step's
// output is written before the next step starts (UC-18), so a restart continues from it, and the
// step drawer (UC-22) shows it.
import type {
  ApplicationStatus,
  CvLanguage,
  HumanDecision,
  QuestionAnswer,
  SkipReason,
  SubmissionRefusalReason,
} from "@bs-job-agents/shared";

/** A job selected for a per-job branch (branch key = jobId). */
export interface JobRef {
  jobId: number;
  title: string;
  company: string;
}

export interface MapCounts {
  total: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
}

/** A task step: the task while it runs; the bot output (or a cache hit) when done. */
export interface TaskStepRunning {
  taskId: number;
}

export interface MapItemState {
  item: unknown;
  taskId: number;
  /** The job this item stands for (research.fit), when known. */
  jobId?: number;
  /**
   * `waiting`: its task waits for Ba (a login or a CAPTCHA, UC-17) and the map went on without it
   * (PM2 M5); it becomes done or failed once the task settles.
   */
  status?: "done" | "failed" | "waiting";
  output?: unknown;
  error?: string | null;
  /** The pause reason while it waits for Ba, e.g. `needs_login(linkedin.com)`. */
  waitingFor?: string | null;
  /** The follow-up pass its results went through after it finished late (`late-<taskId>`, PM2 M5). */
  pass?: string;
}

export interface MapStepOutput {
  /** `<bot>.<kind>` of the mapped task. */
  taskKey: string;
  items: MapItemState[];
  counts: MapCounts;
}

export interface JoinStepOutput {
  taskKey: string;
  results: { item: unknown; jobId?: number; output: unknown }[];
  failures: { item: unknown; jobId?: number; error: string }[];
  /** Items that wait for Ba (UC-17), listed apart from the failures (PM2 M5). */
  waiting?: { item: unknown; taskId: number; reason: string | null }[];
}

export interface FilterStepOutput {
  /** The items the next map or per-job branch runs over. */
  items: JobRef[];
  [extra: string]: unknown;
}

export interface GateRound {
  /** 1 + the number of times Ba asked for changes. */
  pass: number;
  /** 1..maxRounds within the pass (§7.2 step 7). */
  round: number;
  producerTaskId: number;
  cvVersionId: number | null;
  checkerTaskId: number | null;
  qaReviewId: number | null;
  total: number | null;
  passed: boolean | null;
}

export interface GateStepOutput {
  jobId: number;
  language: CvLanguage;
  pass: number;
  /** Ba's request-changes comment for this pass (UC-09). */
  comment: string | null;
  rounds: GateRound[];
  /** escalated = QA not passed after maxRounds (UC-07 a). */
  outcome: "running" | "passed" | "escalated";
  /** The CV version the review card shows for this language. */
  cvVersionId: number | null;
}

/** Ba's decision on a review card (PM brief: kept for the §5.3 promotion rule and sub-project C). */
export interface ReviewDecision {
  decision: HumanDecision;
  at: string;
  cvVersionId: number | null;
  introText: string | null;
  introEdited: boolean;
  comment: string | null;
  skip: { reason: SkipReason; note: string | null } | null;
  /** A second approval after the first token expired or was denied. */
  reapproval?: boolean;
}

export interface ReviewCvOption {
  language: CvLanguage;
  cvVersionId: number;
  qaPassed: boolean;
  escalated: boolean;
}

export interface HumanStepOutput {
  jobId: number;
  cvVersions: ReviewCvOption[];
  defaultLanguage: CvLanguage;
  qaPassed: boolean;
  escalated: boolean;
  needsInput: boolean;
  /** PM2 S16: the company research failed for good; CV tailored without a profile (flag on the card). */
  companyMissing?: boolean;
  decisions: ReviewDecision[];
}

export type ApplyOutcome =
  | "submitted"
  | "needs_check"
  /** Refused before spawning: no token, expired, reused, wrong job/domain… (nothing ran). */
  | "denied"
  /** The approved PDF's SHA-256 did not match before spawning (decision 2b); nothing ran. */
  | "refused"
  /** Stopped before it spawned for another reason (bot disabled, an engine error); the token is unused. */
  | "not_started"
  /** §7.3b: an uploaded JD with no apply link; Approve only produced the PDF. */
  | "no_apply_link"
  | "cancelled";

export interface ActionStepOutput {
  applicationId: number | null;
  taskId: number | null;
  dryRun: boolean;
  outcome: ApplyOutcome | null;
  error: string | null;
  /** The orchestrator's copy Apply uploads (decision 2b) and its SHA-256: the record cites these, never the bot's. */
  uploaded: { filename: string; path: string; sha256: string } | null;
  /** Answers for Apply's pending questions, from saved answers, form defaults or Ba (UC-12). */
  answers: QuestionAnswer[];
  /** Fields Lead has already asked Ba about. */
  asked: string[];
  /** Times Apply resumed without Ba (its questions all answered themselves); capped. */
  autoResumes?: number;
  /** The §9.1 record, written when Apply reported its result (whatever the run's state). */
  record?: RecordStepOutput | null;
}

export interface RecordStepOutput {
  applicationId: number;
  recorded: boolean;
  status: ApplicationStatus | null;
  refused: SubmissionRefusalReason | null;
  error: string | null;
}
