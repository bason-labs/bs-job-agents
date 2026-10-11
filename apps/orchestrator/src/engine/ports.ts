// What the engine needs from the outside world, as small interfaces (ports). Tests use the
// fakes in ./testing; Phase 3/4 wiring plugs in the real ones (./wiring.ts builds them):
// - runners: `createRunners()` from src/runner (W2b), one per engine
// - FileStore (copyFileVerified, sha256File), BrowserStatusProbe (checkBrowserBridge +
//   browserReadyFor), FigmaPort (the FigmaBridge class), PdfTextExtractor (extractText),
//   GuardHooks (buildSiteGuardSettings, prepareFigmaGuard): src/bridges (W2c)
// - BotRegistry: `loadBots(botsDir)` (W2b); WorkflowSource: workflows/*.yaml (W3a)
import type { BotDefinition, Engine, WorkflowDefinition } from "@bs-job-agents/shared";
import type { ProtectedPagesFingerprint } from "../bridges/figma/fingerprint.js";
import type { ClaudeHookSettings } from "../bridges/hooks/settings.js";

/** Time and timers. The engine never reads Date.now() or calls setTimeout directly. */
export interface Clock {
  now(): Date;
  /** Run `fn` after `delayMs` (immediately when ≤ 0). Returns a handle for clearTimer. */
  setTimer(delayMs: number, fn: () => void): unknown;
  clearTimer(handle: unknown): void;
}

/** Files under data/ (absolute paths). */
export interface FileStore {
  /** Copy, creating parent folders and replacing `to`. Throws when `from` is missing. */
  copy(from: string, to: string): Promise<void>;
  /**
   * Decision 2b: copy, then check the copy's SHA-256 against the approved one. On a mismatch the
   * copy is removed and it throws (W2c `copyFileVerified` → Sha256MismatchError).
   */
  copyVerified(from: string, to: string, expectedSha256: string): Promise<{ sha256: string }>;
  /** Lowercase hex SHA-256 of the file's bytes (shared Sha256Schema). */
  sha256(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  /** A small text file (e.g. a guard's JSONL log), or null when it does not exist. */
  readText(path: string): Promise<string | null>;
  /**
   * PM2 M1: the first `bytes` bytes of a regular file (to check an image's magic bytes), or null
   * when it is missing, a folder or a symbolic link (never followed), or, with `within`, when its
   * real path (folder links resolved) is outside that folder.
   */
  readHead(path: string, bytes: number, within?: string): Promise<Buffer | null>;
}

/**
 * §4.4, §10.3: is Chrome running with this engine's extension installed? W2c:
 * `browserReadyFor(await checkBrowserBridge(), engine)` (it cannot tell whether the extension is
 * signed in; a runner that reports "extension not connected" also means needs_browser).
 */
export interface BrowserStatusProbe {
  isConnected(engine: Engine): Promise<boolean>;
}

/**
 * §6.2: the orchestrator's own Figma connection. W2c's `FigmaBridge` class satisfies it as is.
 * Calls may throw errors for which `isFigmaUnavailable(err)` is true: the CV task then waits as
 * needs_figma instead of failing.
 */
export interface FigmaPort {
  /** `figma_get_status {probe:true}` plus a ping in the CV file; `message` says what Ba should do. */
  status(): Promise<{ connected: boolean; message: string }>;
  ensureDraftsPage(): Promise<{ id: string; name: string }>;
  /** Every page except Drafts (ids, names, text, structure, geometry, styles), before and after each CV task. */
  fingerprintProtectedPages(): Promise<ProtectedPagesFingerprint>;
  findDraftFrame(name: string): Promise<{ id: string; name: string; url: string | null } | null>;
  /** PDF export of a Drafts frame to `outPath` (absolute), hashed (PM decision 2a). No LLM involved. */
  exportFramePdf(frameId: string, outPath: string): Promise<FramePdfExport>;
}

/** What the orchestrator verified about its own PDF export (W2c's FigmaPdfExport has these and more). */
export interface FramePdfExport {
  sha256: string;
  pageCount: number;
  onePageA4: boolean;
  /** First page size in points (additive, F5: QA's verified PDF facts). */
  widthPt?: number;
  heightPt?: number;
}

/** One block decision a guard hook logged (JSONL, `decision: "block"`). */
export interface GuardBlock {
  guard: string;
  tool: string;
  rule: string | null;
  reason: string | null;
  target: string | null;
}

/**
 * Per-task Claude `--settings` hooks (coordinator decision): the engine builds them with the
 * bridges' builders and passes RunnerTask.hookSettings. Each guard logs its decisions to
 * `logFile`; the engine turns blocks into safety.denied events after the task.
 */
export interface GuardHooks {
  /** Claude in Chrome site guard (§4.4, §10.2 rule 7): W2c `buildSiteGuardSettings`. */
  siteGuard(opts: { allowedSites: readonly string[]; logFile: string }): ClaudeHookSettings;
  /** Figma Drafts-only guard (§6.2): W2c `prepareFigmaGuard(...).settings`. */
  figmaGuard(opts: { fingerprint: ProtectedPagesFingerprint; dir: string; logFile: string; draftsPageId: string | null }): Promise<ClaudeHookSettings>;
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

/**
 * bots/<name>/ROLE.md (§5.1, §9 prompt_versions): at start-up the engine stores each bot's text for
 * its promptVersion and refuses to start when ROLE.md changed without a version bump (PM brief).
 * Production: W2b's readBotPromptFiles. Optional (tests skip it).
 */
export interface RolePromptSource {
  roleMd(botName: string): string;
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
  /**
   * PM2 S14: `allowedSites` are the hosts a note may name (the bot's allowlist; Apply: the task's
   * approved domains; none for a bot without a browser). The writer drops notes with secrets,
   * overrides or other hosts (runner/memory-hygiene.ts).
   */
  append(input: { botName: string; notes: readonly string[]; runId: number | null; taskId: number; allowedSites?: readonly string[] }): Promise<void>;
  /**
   * PM2 S5: bots/<name>/memory.md is runtime state and gitignored (like data/), so a fresh clone has
   * none. Start-up creates each missing file from the template; existing notes are never touched.
   */
  seed?(botNames: readonly string[]): Promise<void>;
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
