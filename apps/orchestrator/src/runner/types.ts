// Runner contract (spec §5.5). Shared by the engine (W2a: calls runners, owns FakeRunner)
// and the runner (W2b: ClaudeRunner, CodexRunner). Changing this file needs the coordinator.
import type { BotDefinition, Engine, EngineUsage } from "@bs-job-agents/shared";

/** Everything one attempt of one task needs. Built by the engine; the runner never reads the DB. */
export interface RunnerTask {
  taskId: number;
  runId: number | null;
  attempt: number;
  bot: BotDefinition;
  /** Task kind, e.g. "scan", "tailor", "review", "submit", "consult" (BOT_TASK_KINDS / CONVERSATION_TASK_KINDS). */
  kind: string;
  /**
   * Task input as the bot may see it: valid against `promptInputSchemaFor(bot, kind)`
   * (BOT_TASK_PROMPT_INPUT_SCHEMAS). Never contains the approval token (PM S5): for apply.submit
   * the engine validates the full input with BOT_TASK_INPUT_SCHEMAS, then passes
   * `splitApplySubmitInput(full).prompt`. The runner refuses an input with a forbidden key.
   */
  input: unknown;
  /** Absolute path of bots/<name>/; the CLI runs with this cwd. */
  cwd: string;
  /** Absolute path of data/transcripts/<taskId>-<attempt>.jsonl; the runner appends raw CLI lines. */
  transcriptPath: string;
  /** Extra directories the bot may read (and upload from), e.g. the approved PDF folder for Apply. */
  readDirs?: string[];
  /** Sites the browser may navigate to for this task (bot allowlist, or the approval's domains for Apply). */
  allowedSites?: string[];
  /**
   * Additive (W2a, coordinator decision): Claude --settings hook config built by the engine from
   * the bridges' builders; merged by the runner into its base settings.
   */
  hookSettings?: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Live events while a task runs; the engine turns them into `task.progress` / `engine.usage` events. */
export type RunnerEvent =
  | { type: "started"; engine: Engine; sessionId: string | null; pid: number | null }
  | { type: "progress"; text: string }
  | { type: "tool"; name: string; status: "started" | "done" | "error" | "denied"; summary: string | null }
  | { type: "usage"; engine: Engine; usage: EngineUsage; limited: boolean };

export interface PermissionDenial {
  tool: string;
  input: unknown;
  /**
   * Additive (W2b): "hook" = blocked by a PreToolUse hook (the site guard or the Figma guard:
   * log a safety event); "permission" = a tool outside the bot's allowed tools.
   */
  source?: "permission" | "hook";
  /** Additive (W2b): the CLI's message for the denial, e.g. the hook's reason. */
  reason?: string | null;
}

export type RunnerResult =
  /** Output parsed by the bot's Zod output schema and every self-check item passed. */
  | { status: "ok"; output: unknown; sessionId: string | null; durationMs: number }
  /** Output still invalid after the one repair prompt (§5.5 step 4). */
  | { status: "invalid_output"; errors: string[]; raw: string | null; durationMs: number }
  /** A self-check item failed (§5.5 step 5); output kept for notes. */
  | { status: "self_check_failed"; output: unknown; failed: string[]; durationMs: number }
  /** Subscription limit hit; the engine pauses the engine until resetsAt (UC-16). */
  | { status: "usage_limit"; engine: Engine; resetsAt: string | null; durationMs: number }
  /** A tool outside the bot's permissions was requested (real denials only, PM/S1 cross-check). */
  | { status: "denied"; denials: PermissionDenial[]; output: unknown | null; durationMs: number }
  | { status: "failed"; error: string; exitCode: number | null; durationMs: number }
  | { status: "timeout"; durationMs: number }
  | { status: "cancelled"; durationMs: number };

/** One implementation per engine (claude, codex) plus FakeRunner for tests. */
export interface Runner {
  readonly engine: Engine | "fake";
  run(task: RunnerTask, onEvent: (event: RunnerEvent) => void): Promise<RunnerResult>;
}
