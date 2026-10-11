// The engine's shared context: dependencies, settings and the cross-module hooks the Engine
// class implements (advance a run, dispatch tasks, pause an engine, wait for a bridge).
import type { Engine as EngineName, PauseReason } from "@bs-job-agents/shared";
import type { Conn, Db, Task } from "../db/index.js";
import type { Runner } from "../runner/types.js";
import type { EngineConfig, EnginePaths } from "./config.js";
import type { ConversationSink } from "./conversations.js";
import type { FactDraftSink } from "./fact-drafts.js";
import type { EventBus } from "./events.js";
import type { ScanOutputChecker } from "./scan-check.js";
import type {
  BotRegistry,
  BrowserStatusProbe,
  Clock,
  FeedScanPort,
  FigmaPort,
  FileStore,
  GuardHooks,
  Logger,
  MasterCvSource,
  MemoryWriter,
  OrphanKiller,
  PdfTextExtractor,
  RolePromptSource,
  WorkflowSource,
} from "./ports.js";

export interface EngineDeps {
  db: Db;
  /** One runner per engine: `createRunners()` (W2b) in production, a FakeRunner in tests. */
  runners: Record<EngineName, Runner>;
  bots: BotRegistry;
  workflows: WorkflowSource;
  paths: EnginePaths;
  files: FileStore;
  browser: BrowserStatusProbe;
  figma: FigmaPort;
  /** Per-task guard hooks for Claude (site guard, Figma guard). */
  guards: GuardHooks;
  pdf: PdfTextExtractor;
  masterCv: MasterCvSource;
  clock?: Clock;
  config?: Partial<EngineConfig>;
  /** Rule 2: memory notes (W2b's appendMemoryNotes + appendMemoryChange). Optional. */
  memory?: MemoryWriter;
  /** UC-18: kill CLI process groups a crash left behind. Optional. */
  processes?: OrphanKiller;
  /** ROLE.md per bot, for prompt_versions at start-up. Optional. */
  prompts?: RolePromptSource;
  /** PM2 S2: W3a's chat flows; called in the transaction that settles a conversation task. Optional. */
  conversations?: ConversationSink;
  /** Owner request 2026-10-11: the API adds cv.fact_draft results to the master CV, in the settle transaction. Optional. */
  factDrafts?: FactDraftSink;
  /** PM3 S8: checks each research.scan output where it settles (W4a: src/adapters/**). Default: accept. */
  scanChecker?: ScanOutputChecker;
  /** W5: feed sources in a job scan, fetched by the orchestrator (no bot). Default: such a source fails, saying it is not wired. */
  feeds?: FeedScanPort;
  logger?: Logger;
}

export interface EngineCore {
  readonly db: Db;
  readonly deps: EngineDeps;
  readonly config: EngineConfig;
  readonly paths: EnginePaths;
  readonly clock: Clock;
  readonly bus: EventBus;
  readonly log: Logger;
  now(): Date;
  /** Move a run forward from what the database says (sync, idempotent), then deliver events. */
  advance(runId: number | null): void;
  /** Claim and start runnable tasks within caps and locks (sync). */
  dispatch(): void;
  /** UC-16: pause an engine for a usage limit and hold its queued tasks (inside `conn`'s transaction). */
  pauseEngineForLimit(conn: Conn, engine: EngineName, resetsAt: string | null): void;
  /** §10.3: a task waits for Chrome or the Figma bridge; resumes by itself on reconnect. */
  waitForBridge(
    conn: Conn,
    task: Task,
    reason: Extract<PauseReason["code"], "needs_browser" | "needs_figma">,
    opts?: { detail?: string; output?: unknown },
  ): void;
  /** Abort a running task (run cancelled). */
  abortTask(taskId: number): boolean;
}
