// In-memory state of the mock orchestrator. Records use the shared domain types; ids look like
// the real ones (numeric strings), and step outputs mirror what the engine persists.
import type {
  Application,
  ApplicationDetail,
  BotView,
  EngineStatus,
  Export,
  FactRequestItem,
  FileRef,
  MasterCv,
  Message,
  PauseReason,
  PendingQuestion,
  ReviewCard,
  Room,
  Run,
  SavedAnswer,
  ScheduleView,
  SearchProfile,
  Step,
  Task,
  Upload,
  WorkflowProposal,
} from "@bs-job-agents/shared";
import type { ProgressLine } from "../contract";
import type { MockLeadProposal } from "./lead-proposals";

/** A step row plus its last preview text (the engine only sends it in step.* events; W3a handoff). */
export interface StepRow extends Step {
  preview: string | null;
}

export interface LaneInfo {
  jobId: string;
  title: string;
  company: string;
}

export interface RunState {
  run: Run;
  steps: StepRow[];
  tasks: Task[];
  /** Jobs selected for per-job branches, in order. */
  lanes: LaneInfo[];
}

/** A task that waits for Ba: a question card (UC-12) or a pause card (UC-17, UC-11 e). */
export interface MockPause {
  taskId: string;
  runId: string | null;
  botName: string;
  reason: PauseReason;
  applicationId: string | null;
  jobId: string | null;
  /** UC-12: questions still to ask, in Apply's order; the first one is on screen. */
  questions: PendingQuestion[];
}

/** What the Applications screen shows beside an application (job, CV, files); W3a views/applications.ts. */
export interface ApplicationExtra {
  job: ApplicationDetail["job"];
  cvVersion: ApplicationDetail["cvVersion"];
  submission: ApplicationDetail["submission"];
  files: FileRef[];
  confirmationScreenshotFileId: string | null;
  partialRecord: boolean;
  cvFile: FileRef | null;
}

/** data/master-cv.yaml as the orchestrator reads it: missing, unreadable, or the CV. */
export type MockMasterCv = { kind: "ok"; cv: MasterCv } | { kind: "missing" } | { kind: "invalid"; detail: string };

export interface MockState {
  bots: BotView[];
  engines: EngineStatus[];
  chromeConnected: boolean;
  rooms: Room[];
  messages: Record<string, Message[]>;
  runs: Record<string, RunState>;
  /** The review queue, oldest first. */
  queue: ReviewCard[];
  /** Questions Apply meets on each job's form (UC-12). */
  forms: Record<string, PendingQuestion[]>;
  applications: Record<string, Application>;
  /** Job, CV and files per application id (seeded rows; the sim adds one per approval). */
  applicationExtras: Record<string, ApplicationExtra>;
  exports: Export[];
  /** The data folder GET /applications reports (UC-13b). */
  dataDir: string;
  uploads: Record<string, Upload>;
  /** Viewer URLs by file id (seeded CV PDFs point at /public/dev samples). */
  fileUrls: Record<string, string>;
  transcripts: Record<string, ProgressLine[]>;
  pauses: Record<string, MockPause>;
  savedAnswers: SavedAnswer[];
  /** The active Search Profile's version (kept equal to the active row in `profiles`). */
  criteriaVersion: number;
  /** Every Search Profile version (a save adds a row; one row is active). */
  profiles: SearchProfile[];
  /** Schedules, soft-deleted ones included (deletedAt set; purged after the undo window). */
  schedules: ScheduleView[];
  masterCv: MockMasterCv;
  masterCvVersions: { version: number; savedAt: string; factCount: number }[];
  factRequests: FactRequestItem[];
  /** Lead's propose_workflow suggestions (rule 3), oldest first. */
  proposals: WorkflowProposal[];
  /** Workflows saved by approving a proposal: name → latest version. */
  savedWorkflows: Record<string, number>;
  /** PM3 M3 / S1: Lead's criteria and schedule proposals waiting for Ba's click, by id. */
  leadProposals?: Record<string, MockLeadProposal>;
  /** Next id for new records. */
  seq: number;
}
