// What the engine needs from the outside world, as small interfaces (ports). Tests use the
// fakes in ./testing; Phase 3/4 wiring plugs in the real ones:
// - runners: `createRunners()` from src/runner (W2b), one per engine
// - FileStore, BrowserStatusProbe, FigmaBridge, PdfTextExtractor: src/bridges (W2c)
// - BotRegistry: `loadBots(botsDir)` (W2b); WorkflowSource: workflows/*.yaml (W3a)
import type { BotDefinition, Engine, WorkflowDefinition } from "@bs-job-agents/shared";

/** Time and timers. The engine never reads Date.now() or calls setTimeout directly. */
export interface Clock {
  now(): Date;
  /** Run `fn` after `delayMs` (immediately when ≤ 0). Returns a handle for clearTimer. */
  setTimer(delayMs: number, fn: () => void): unknown;
  clearTimer(handle: unknown): void;
}

/** Files under data/ (absolute paths). W2c's streaming SHA-256 helper can back this. */
export interface FileStore {
  /** Copy, creating parent folders and replacing `to`. Throws when `from` is missing. */
  copy(from: string, to: string): Promise<void>;
  /** Lowercase hex SHA-256 of the file's bytes (shared Sha256Schema). */
  sha256(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
}

/** §4.4, §10.3: is Chrome running with this engine's extension connected? */
export interface BrowserStatusProbe {
  isConnected(engine: Engine): Promise<boolean>;
}

/** §6.2: the local figma-console-mcp bridge and its Desktop Bridge plugin (W2c). */
export interface FigmaBridge {
  /** `figma_get_status {probe:true}`: Figma desktop with the CV file and the plugin running. */
  status(): Promise<{ connected: boolean }>;
  /** Fingerprint of every protected page (node ids, names, text), taken before and after each CV task. */
  fingerprintProtectedPages(): Promise<string>;
  /**
   * Export a Drafts frame as PDF (`exportAsync({format:'PDF'})` + base64) to `outPath` (absolute),
   * then hash it (PM decision 2a). No LLM involved.
   */
  exportFramePdf(input: { frameName: string; outPath: string }): Promise<{ sha256: string; pageCount: number }>;
}

/** §6.2: pdfminer/PDF.js-style text extraction (never macOS PDFKit). */
export interface PdfTextExtractor {
  extractText(path: string): Promise<string>;
}

/** data/master-cv.yaml (§6.1): Ba's master facts. Bots only read a per-task copy of it. */
export interface MasterCvSource {
  /** Absolute path of data/master-cv.yaml. */
  readonly path: string;
  /** The current master version, or null when Ba has not created the master CV yet (UC-01 c). */
  version(): number | null;
}

/** bot.json definitions by name (§5.1). The DB row may override the engine and trust level (Bots screen). */
export interface BotRegistry {
  get(name: string): BotDefinition | undefined;
  list(): BotDefinition[];
}

/** Workflow definitions (§7), validated with WorkflowDefinitionSchema. */
export interface WorkflowSource {
  /** A specific version, or the latest when `version` is omitted. */
  get(name: string, version?: number): WorkflowDefinition | undefined;
}

/** Rule 2 (§5.4): append a task's memoryNotes to the bot's memory.md, one at a time (W2b's appendMemoryNotes). */
export interface MemoryWriter {
  append(input: { botName: string; notes: readonly string[]; runId: number | null; taskId: number }): Promise<void>;
}

/**
 * Crash recovery (UC-18): CLI process groups a crashed orchestrator left running, by the pid the
 * runner reported in its `started` event. The implementation should check the pid still belongs
 * to a claude/codex process before killing it (pids are reused).
 */
export interface OrphanKiller {
  killGroup(pid: number): void;
}

export interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export const silentLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
