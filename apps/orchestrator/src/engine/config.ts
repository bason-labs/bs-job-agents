// Engine settings (defaults from the shared LIMITS) and the data/ folder layout.
import { isAbsolute, join, relative } from "node:path";
import { LIMITS, type Engine } from "@bs-job-agents/shared";

export interface EngineConfig {
  /** §10.3: max concurrent sessions per engine (default Claude 2, Codex 2). */
  engineCaps: Record<Engine, number>;
  /** §5.5 step 6: initial + 1 retry. */
  maxAttempts: number;
  /** UC-16: when the reset time is unknown, try again after this long. */
  usageRetryMs: number;
  /** UC-16: pause before the wall at this utilization (0–1). */
  usagePauseUtilization: number;
  /** How often to re-check Chrome / the Figma bridge while tasks wait as needs_browser / needs_figma. */
  bridgePollMs: number;
  /** How often the scheduler looks for due schedules. */
  schedulerPollMs: number;
  /** Extra time after a task's own timeout before the engine aborts it (the runner times out first). */
  timeoutGraceMs: number;
  /** §7.4: a missed schedule fires once if it was due within this window. */
  catchUpWindowMs: number;
  /** A schedule that fires later than this is reported as a catch-up run (schedule.fired catchUp). */
  catchUpAfterMs: number;
  /** PM FYI d: the uploaded file is named `<applicantName>_<COMPANY>_<LANG>.pdf`. */
  applicantName: string;
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  engineCaps: { ...LIMITS.engineSessionsDefault },
  maxAttempts: LIMITS.maxAttempts,
  usageRetryMs: LIMITS.usageRetryMs,
  usagePauseUtilization: LIMITS.usagePauseUtilization,
  bridgePollMs: 15_000,
  schedulerPollMs: 30_000,
  timeoutGraceMs: 30_000,
  catchUpWindowMs: LIMITS.catchUpWindowMs,
  catchUpAfterMs: 2 * 60_000,
  applicantName: "BA_HUYNH",
};

export function resolveEngineConfig(over: Partial<EngineConfig> = {}): EngineConfig {
  return { ...DEFAULT_ENGINE_CONFIG, ...over, engineCaps: { ...DEFAULT_ENGINE_CONFIG.engineCaps, ...over.engineCaps } };
}

/**
 * The data/ layout the engine writes to. Paths stored in the DB are relative to data/ (PM brief),
 * so restores and exports keep working; the runner and bridges get absolute ones.
 */
export class EnginePaths {
  constructor(
    /** Absolute data/ folder. */
    readonly dataDir: string,
    /** Absolute bots/ folder. */
    readonly botsDir: string,
  ) {
    if (!isAbsolute(dataDir) || !isAbsolute(botsDir)) throw new Error("EnginePaths needs absolute data and bots folders");
  }

  abs(path: string): string {
    return isAbsolute(path) ? path : join(this.dataDir, path);
  }

  /** Relative to data/ (POSIX separators). */
  rel(path: string): string {
    return isAbsolute(path) ? relative(this.dataDir, path).split("\\").join("/") : path;
  }

  botDir(botName: string): string {
    return join(this.botsDir, botName);
  }

  /** §5.5 step 3: data/transcripts/<taskId>-<attempt>.jsonl */
  transcript(taskId: number, attempt: number): string {
    return `transcripts/${taskId}-${attempt}.jsonl`;
  }

  /** §6.2: the orchestrator exports a Drafts frame to data/pdf/<frameName>.pdf. */
  pdf(frameName: string): string {
    return `pdf/${frameName}.pdf`;
  }

  /**
   * §9.1: data/applications/<applicationId>/ holds the approved PDF copy Apply uploads (its only
   * read folder, decision 2b) and the record's files.
   */
  applicationDir(applicationId: number): string {
    return `applications/${applicationId}`;
  }

  /** A task's own read folder (copies of master-cv.yaml or an uploaded JD), so a bot never reads all of data/. */
  taskDir(taskId: number): string {
    return `tasks/${taskId}`;
  }
}
