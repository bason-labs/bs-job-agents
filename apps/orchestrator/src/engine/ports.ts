// What the engine needs from the outside world, as small interfaces (ports). Tests use the
// fakes in ./testing; Phase 3/4 wiring plugs in the real ones (./wiring.ts builds them):
// - runners: `createRunners()` from src/runner (W2b), one per engine
// - FileStore (copyFileVerified, sha256File), BrowserStatusProbe (checkBrowserBridge +
//   browserReadyFor), FigmaPort (the FigmaBridge class), PdfTextExtractor (extractText),
//   GuardHooks (buildSiteGuardSettings, prepareFigmaGuard): src/bridges (W2c)
// - BotRegistry: `loadBots(botsDir)` (W2b); WorkflowSource: workflows/*.yaml (W3a)
import type {
  BoardSource,
  BotDefinition,
  Engine,
  FeedSource,
  GuidanceMarket,
  GuidanceRuleSet,
  GuidanceSourceKind,
  MasterCv,
  ResearchScanInput,
  ResearchScanOutput,
  SourceAccessRecord,
  WorkflowDefinition,
} from "@bs-job-agents/shared";
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
  /** Write a small text file (a task's master-CV copy), creating parent folders and replacing it. */
  writeText(path: string, text: string): Promise<void>;
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
  /** CV guidance (additive): the parsed master CV (its contact decides has_profile_link), or null. */
  read?(): MasterCv | null;
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

/**
 * W5: feed sources (Remote OK, We Work Remotely, Remotive, Jobspresso) in a job scan. The
 * orchestrator fetches the board's public feed itself and answers in research.scan's output shape:
 * no bot, no LLM, no engine session. Production: src/adapters/feeds FeedScanner. Throws on a
 * failed fetch (the source fails; the scan goes on with the others).
 */
export interface FeedScanPort {
  scan(source: FeedSource, input: ResearchScanInput, signal?: AbortSignal): Promise<ResearchScanOutput>;
}

/** One request a board-API scan sent: method, host and path only (no query, no header). */
export interface BoardRequestRecord {
  method: "GET";
  host: string;
  path: string;
}

/**
 * API research (AD-2, AD-5, design §5.2): boards read through a public or account API, fetched by
 * the orchestrator (no bot, no LLM). Production: src/adapters/board-api BoardApiScanner.
 * `scan` throws MissingCredential (no request sent), AuthRejected (401/403), BoardApiError
 * (`kind` transient | failed) or EndpointNotAllowed; every message is already redacted.
 */
export interface BoardScanPort {
  /** The board's access record (shared source-access by default). */
  record(source: BoardSource): SourceAccessRecord;
  /** A mapper reads this board (without one, the board stays on the browser). */
  canScan(source: BoardSource): boolean;
  /** Its credentials are configured (never their values). */
  hasCredentials(source: BoardSource): boolean;
  scan(
    source: BoardSource,
    req: { path: "public_api" | "account_api"; input: ResearchScanInput; signal?: AbortSignal; onRequest?: (r: BoardRequestRecord) => void },
  ): Promise<{ jobs: unknown[]; note?: string }>;
  /** Every credential value read so far, replaced (for text built on this path). */
  redact(text: string): string;
}

/**
 * API research (AD-4, design §5.3): a board's account credentials (several named values, e.g.
 * LinkedIn's li_at cookie and its CSRF header), from a local file outside the repository.
 * Production: src/adapters/secrets FileSecretStore. Only the board-API path and the wiring read
 * values; everyone else may ask `has` (the Search criteria screen's "token missing").
 */
export interface SecretStore {
  /** The board's named values, or null when none is configured. */
  credentials(source: string): Record<string, string> | null;
  has(source: string): boolean;
}

/** One page to (re)fetch for the CV guidance refresh (§5.4): its validators when known. */
export interface GuidanceFetchRequest {
  url: string;
  etag: string | null;
  lastModified: string | null;
}

export type GuidanceFetchResult =
  | {
      url: string;
      status: "ok";
      finalUrl: string;
      title: string | null;
      /** Main text, plain (no markup), capped. */
      text: string;
      /** sha256 of guidanceContentKey(text). */
      contentHash: string;
      etag: string | null;
      lastModified: string | null;
      /** Registrable domain, by code. */
      host: string;
      kind: GuidanceSourceKind;
      market: GuidanceMarket;
    }
  | { url: string; status: "not_modified" }
  | { url: string; status: "failed"; reason: string };

/**
 * CV guidance (§5.4, SEC-21): the orchestrator's own fetcher for guidance pages: https only, public
 * addresses only (re-checked after each redirect, at most 3), no cookie, Authorization or board
 * token, 2 MiB and 20 s per page, a per-host gap, conditional GETs. Production:
 * src/adapters/guidance-fetch GuidanceFetcher. Never throws for one page: it reports it failed.
 */
export interface GuidanceFetchPort {
  fetchPages(requests: readonly GuidanceFetchRequest[], opts?: { signal?: AbortSignal }): Promise<GuidanceFetchResult[]>;
}

/** CV guidance wiring: the fetcher and the seed committed at start when the store lacks it. */
export interface GuidanceDeps {
  fetch: GuidanceFetchPort;
  seed?: GuidanceRuleSet;
}

/**
 * Skill self-repair (§5.5, AD-7, SEC-10): a source's skill file, read and replaced only through this
 * port. Production: src/adapters/skill-store SkillStore (one file per source, atomic, no links).
 */
export interface SkillFiles {
  /** The file's path relative to the repository (shown on the Activity screen). */
  pathOf(source: string): string;
  /** The text in force; throws when the file cannot be read safely. */
  read(source: string): string;
  /** Replace it atomically; throws when refused or on an I/O error (the file is then unchanged). */
  write(source: string, text: string): void;
}

export interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export const silentLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
