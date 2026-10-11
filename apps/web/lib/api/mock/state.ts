// In-memory state of the mock orchestrator. Records use the shared domain types; ids look like
// the real ones (numeric strings), and step outputs mirror what the engine persists.
import type {
  Application,
  BotView,
  EngineStatus,
  Message,
  PauseReason,
  PendingQuestion,
  ReviewCard,
  Room,
  Run,
  Step,
  Task,
  Upload,
} from "@bs-job-agents/shared";
import type { TranscriptLine } from "../contract";

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
  uploads: Record<string, Upload>;
  /** Viewer URLs by file id (seeded CV PDFs point at /public/dev samples). */
  fileUrls: Record<string, string>;
  transcripts: Record<string, TranscriptLine[]>;
  pauses: Record<string, MockPause>;
  savedAnswers: { key: string; label: string; answer: string }[];
  criteriaVersion: number;
  /** Next id for new records. */
  seq: number;
}
