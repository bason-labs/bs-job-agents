// Figma bridge (spec §4.2, §6.2; spike S3b): the orchestrator's own connection to Figma desktop
// through a local figma-console-mcp server. It checks availability (`needs_figma`), prepares the
// Drafts page, copies templates, exports PDFs without an LLM and fingerprints the protected pages.
// One CV task uses Figma at a time: the Figma lock belongs to the engine.
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { sha256Bytes, sha256File } from "../pdf/hash.js";
import { pdfInfoFromBytes } from "../pdf/info.js";
import { DEFAULT_CV_FILE_KEY, DRAFTS_PAGE_NAME, FIGMA_EXECUTE_MAX_MS } from "./constants.js";
import { FigmaBridgeError, isFigmaUnavailable } from "./errors.js";
import {
  buildFingerprint,
  templatesFromFingerprint,
  type FigmaTemplate,
  type PageSnapshot,
  type ProtectedPagesFingerprint,
} from "./fingerprint.js";
import { connectFigmaConsoleMcp, type FigmaMcpClient, type McpToolResult } from "./mcp.js";
import {
  duplicateTemplateCode,
  ensureDraftsPageCode,
  exportPdfCode,
  fileResourcesCode,
  findDraftFrameCode,
  fingerprintPageCode,
  listPagesCode,
  pingCode,
} from "./plugin-code.js";
import { parseExecuteReply, parseStatusReply, serverUnavailableStatus, type FigmaStatus } from "./replies.js";

export interface FigmaBridgeOptions {
  /** Starts the MCP connection (default: spawn the pinned figma-console-mcp). Tests pass a fake. */
  connect?: () => Promise<FigmaMcpClient>;
  /** The CV file; every call runs in it (default kJFoXNrTfFOtkQ515c0jHk). null: whatever file is active. */
  fileKey?: string | null;
  draftsPageName?: string;
  now?: () => Date;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** After a good probe, ping the CV file itself (default true). */
  pingOnStatus?: boolean;
}

export interface FigmaDraftsPage {
  id: string;
  name: string;
  created: boolean;
}

export interface FigmaFrameInfo {
  id: string;
  name: string;
  pageId: string;
  width: number;
  height: number;
  type?: string;
  visible?: boolean;
  /** Link that opens the frame in Figma. */
  url: string | null;
}

export interface FigmaPdfExport {
  /** Absolute path of the written file. */
  path: string;
  /** File size in bytes. */
  bytes: number;
  /** SHA-256 of the bytes written, lowercase hex (goes to cv_versions.pdf_sha256). */
  sha256: string;
  pageCount: number;
  widthPt: number;
  heightPt: number;
  /** Exactly one A4 portrait page (the CV rule; the caller decides what to do otherwise). */
  onePageA4: boolean;
  frameId: string;
  frameName: string;
}

export interface WaitForConnectionOptions {
  /** Give up after this long and return the last status (default 5 min). */
  timeoutMs?: number;
  /** First pause between polls (default 1 s), doubled up to `maxDelayMs` (default 15 s). */
  initialDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  signal?: AbortSignal;
}

const DraftsPageSchema = z.object({ id: z.string(), name: z.string(), created: z.boolean() });
const FrameReplySchema = z.object({
  id: z.string(),
  name: z.string(),
  pageId: z.string(),
  width: z.number(),
  height: z.number(),
  type: z.string().optional(),
  visible: z.boolean().optional(),
});
const ExportReplySchema = z.object({
  base64: z.string(),
  name: z.string(),
  width: z.number(),
  height: z.number(),
  pageName: z.string().nullable(),
});
const PageListSchema = z.array(z.object({ id: z.string(), name: z.string() }));
const PageSnapshotSchema = z.object({
  id: z.string(),
  name: z.string(),
  nodes: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      name: z.string(),
      parentId: z.string(),
      index: z.number(),
      visible: z.boolean().optional(),
      locked: z.boolean().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      w: z.number().optional(),
      h: z.number().optional(),
      text: z.string().optional(),
      style: z.record(z.unknown()).optional(),
    }),
  ),
});

/** Figma node ids: "601:12", instance layers "I601:12;3:4". */
const NODE_ID_RE = /^[A-Za-z0-9:;_-]+$/;

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolveSleep) => {
    const timer = setTimeout(resolveSleep, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolveSleep();
      },
      { once: true },
    );
  });

function slug(name: string | null): string {
  const s = (name ?? "")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "file";
}

function parseWith<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new FigmaBridgeError("bad_reply", `unexpected ${what} reply from the plugin`, parsed.error.issues);
  return parsed.data;
}

export class FigmaBridge {
  readonly fileKey: string | null;
  readonly draftsPageName: string;
  private readonly connectFn: () => Promise<FigmaMcpClient>;
  private readonly now: () => Date;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly pingOnStatus: boolean;
  private client: FigmaMcpClient | null = null;
  private connecting: Promise<FigmaMcpClient> | null = null;
  private lastFileName: string | null = null;

  constructor(opts: FigmaBridgeOptions = {}) {
    this.connectFn = opts.connect ?? (() => connectFigmaConsoleMcp());
    this.fileKey = opts.fileKey === undefined ? DEFAULT_CV_FILE_KEY : opts.fileKey;
    this.draftsPageName = opts.draftsPageName ?? DRAFTS_PAGE_NAME;
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? defaultSleep;
    this.pingOnStatus = opts.pingOnStatus ?? true;
  }

  // ---- connection ----------------------------------------------------------------------------

  private async getClient(): Promise<FigmaMcpClient> {
    if (this.client && !this.client.closed) return this.client;
    this.client = null;
    this.connecting ??= this.connectFn()
      .then((c) => {
        this.client = c;
        return c;
      })
      .finally(() => {
        this.connecting = null;
      });
    try {
      return await this.connecting;
    } catch (err) {
      throw new FigmaBridgeError("server_unavailable", `could not start figma-console-mcp: ${(err as Error).message}`);
    }
  }

  private async dropClient(): Promise<void> {
    const c = this.client;
    this.client = null;
    await c?.close().catch(() => undefined);
  }

  private async call(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<McpToolResult> {
    const client = await this.getClient();
    try {
      return await client.callTool(name, args, { timeoutMs });
    } catch (err) {
      const e = err as Error & { code?: unknown };
      if (e.code === -32001 || /timed? ?out/i.test(e.message)) {
        throw new FigmaBridgeError("timeout", `${name} timed out: ${e.message}`);
      }
      await this.dropClient(); // the next call starts a fresh server
      throw new FigmaBridgeError("server_unavailable", `${name} failed: ${e.message}`);
    }
  }

  /** Starts the local server now instead of on first use. */
  async start(): Promise<void> {
    await this.getClient();
  }

  async stop(): Promise<void> {
    await this.connecting?.catch(() => undefined);
    await this.dropClient();
  }

  // ---- status ----------------------------------------------------------------------------------

  /** `figma_get_status {probe:true}`, then a ping in the CV file. Never throws for a missing Figma. */
  async status(): Promise<FigmaStatus> {
    const now = this.now();
    let result: McpToolResult;
    try {
      result = await this.call("figma_get_status", { probe: true }, 15_000);
    } catch (err) {
      if (!(err instanceof FigmaBridgeError)) throw err;
      if (err.code === "server_unavailable") return serverUnavailableStatus(err.message, now);
      return { ...serverUnavailableStatus(err.message, now), state: "not_connected", message: `Figma did not answer: ${err.message}` };
    }
    const status = parseStatusReply(result, this.fileKey, now);
    if (status.fileName) this.lastFileName = status.fileName;
    if (status.connected && this.pingOnStatus) {
      try {
        await this.execute(pingCode(), { timeoutMs: 5000 });
      } catch (err) {
        if (!(err instanceof FigmaBridgeError)) throw err;
        return { ...status, state: "not_connected", connected: false, message: `The CV file did not answer: ${err.message}` };
      }
    }
    return status;
  }

  /** Polls `status()` with exponential backoff until connected, aborted or timed out. */
  async waitForConnection(opts: WaitForConnectionOptions = {}): Promise<FigmaStatus> {
    const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
    const maxDelay = opts.maxDelayMs ?? 15_000;
    const factor = opts.factor ?? 2;
    const deadline = this.now().getTime() + timeoutMs;
    let delay = opts.initialDelayMs ?? 1000;
    for (;;) {
      const status = await this.status();
      if (status.connected || opts.signal?.aborted) return status;
      const remaining = deadline - this.now().getTime();
      if (remaining <= 0) return status;
      await this.sleep(Math.min(delay, maxDelay, remaining), opts.signal);
      if (opts.signal?.aborted) return status;
      delay = Math.min(delay * factor, maxDelay);
    }
  }

  // ---- code ------------------------------------------------------------------------------------

  /**
   * Runs plugin code in the CV file. One call may take at most 30 s (figma-console-mcp's cap),
   * so long edits must be split into several calls.
   */
  async execute<T = unknown>(code: string, opts: { timeoutMs?: number } = {}): Promise<T> {
    if (typeof code !== "string" || code.trim() === "") throw new FigmaBridgeError("invalid_argument", "no code to run");
    const timeoutMs = opts.timeoutMs ?? 10_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > FIGMA_EXECUTE_MAX_MS) {
      throw new FigmaBridgeError(
        "invalid_argument",
        `timeoutMs must be a whole number from 1 to ${FIGMA_EXECUTE_MAX_MS}; split longer edits into several calls`,
      );
    }
    const args: Record<string, unknown> = { code, timeout: timeoutMs, ...(this.fileKey ? { fileKey: this.fileKey } : {}) };
    // The server itself allows the plugin 2 s more; leave room for both before giving up.
    const out = parseExecuteReply(await this.call("figma_execute", args, timeoutMs + 15_000), this.fileKey);
    if (!out.ok) throw out.error;
    if (out.fileName) this.lastFileName = out.fileName;
    return out.value as T;
  }

  // ---- Drafts and templates ---------------------------------------------------------------------

  async ensureDraftsPage(): Promise<FigmaDraftsPage> {
    return parseWith(DraftsPageSchema, await this.execute(ensureDraftsPageCode(this.draftsPageName)), "Drafts page");
  }

  async findDraftFrame(name: string): Promise<FigmaFrameInfo | null> {
    const reply = await this.execute(findDraftFrameCode(name, this.draftsPageName));
    if (reply === null) return null;
    const frame = parseWith(FrameReplySchema, reply, "frame");
    return { ...frame, url: this.frameUrl(frame.id) };
  }

  /** Copies a template frame to the Drafts page under `newName` (`<COMPANY>_<ROLE>_<LANG>_v<n>`). */
  async duplicateTemplate(templateFrameId: string, newName: string): Promise<FigmaFrameInfo> {
    if (!NODE_ID_RE.test(templateFrameId)) throw new FigmaBridgeError("invalid_argument", `not a Figma node id: "${templateFrameId}"`);
    if (newName.trim() === "" || newName.length > 200) throw new FigmaBridgeError("invalid_argument", "the frame name must be 1–200 characters");
    const reply = await this.execute(duplicateTemplateCode(templateFrameId, newName, this.draftsPageName), { timeoutMs: FIGMA_EXECUTE_MAX_MS });
    const frame = parseWith(FrameReplySchema, reply, "duplicate");
    return { ...frame, url: this.frameUrl(frame.id) };
  }

  /** CV templates (A4 frames on the protected pages). */
  async listTemplates(opts?: { a4Only?: boolean }): Promise<FigmaTemplate[]> {
    return templatesFromFingerprint(await this.fingerprintProtectedPages(), opts);
  }

  // ---- export ----------------------------------------------------------------------------------

  /**
   * Exports a frame as PDF (`exportAsync({format:'PDF'})` + `figma.base64Encode`), writes it to
   * `outPath` atomically and hashes the bytes written (PM decision 2a). By default only frames on
   * the Drafts page can be exported.
   */
  async exportFramePdf(frameId: string, outPath: string, opts: { requireDrafts?: boolean } = {}): Promise<FigmaPdfExport> {
    if (!NODE_ID_RE.test(frameId)) throw new FigmaBridgeError("invalid_argument", `not a Figma node id: "${frameId}"`);
    const reply = parseWith(
      ExportReplySchema,
      await this.execute(exportPdfCode(frameId, this.draftsPageName, opts.requireDrafts ?? true), { timeoutMs: FIGMA_EXECUTE_MAX_MS }),
      "export",
    );
    const bytes = Buffer.from(reply.base64, "base64");
    if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
      throw new FigmaBridgeError("export_failed", `the export of ${reply.name} is not a PDF`);
    }
    let info: Awaited<ReturnType<typeof pdfInfoFromBytes>>;
    try {
      info = await pdfInfoFromBytes(bytes);
    } catch (err) {
      throw new FigmaBridgeError("export_failed", `the exported PDF of ${reply.name} does not open: ${(err as Error).message}`);
    }

    const path = resolve(outPath);
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(tmp, bytes);
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw new FigmaBridgeError("export_failed", `could not write ${path}: ${(err as Error).message}`);
    }
    const sha256 = sha256Bytes(bytes);
    if ((await sha256File(path)) !== sha256) {
      await rm(path, { force: true });
      throw new FigmaBridgeError("export_failed", `${path} does not match the exported bytes`);
    }
    return {
      path,
      bytes: bytes.length,
      sha256,
      pageCount: info.pageCount,
      widthPt: info.widthPt,
      heightPt: info.heightPt,
      onePageA4: info.onePageA4,
      frameId,
      frameName: reply.name,
    };
  }

  // ---- fingerprint ------------------------------------------------------------------------------

  /** Fingerprint of every page except Drafts (one call per page, each under the 30 s cap). */
  async fingerprintProtectedPages(): Promise<ProtectedPagesFingerprint> {
    const pages = parseWith(PageListSchema, await this.execute(listPagesCode()), "page list");
    const snapshots: PageSnapshot[] = [];
    for (const page of pages) {
      if (page.name === this.draftsPageName) continue;
      snapshots.push(
        parseWith(PageSnapshotSchema, await this.execute(fingerprintPageCode(page.id), { timeoutMs: FIGMA_EXECUTE_MAX_MS }), "page fingerprint"),
      );
    }
    let resources: unknown = null;
    let resourcesError: string | null = null;
    try {
      resources = await this.execute(fileResourcesCode(), { timeoutMs: FIGMA_EXECUTE_MAX_MS });
    } catch (err) {
      if (!(err instanceof FigmaBridgeError) || isFigmaUnavailable(err)) throw err;
      resourcesError = err.message;
    }
    return buildFingerprint({
      fileKey: this.fileKey,
      draftsPageName: this.draftsPageName,
      pages: snapshots,
      resources,
      resourcesError,
      takenAt: this.now().toISOString(),
    });
  }

  /** Link that opens a node in Figma (null without a file key). */
  frameUrl(nodeId: string): string | null {
    if (!this.fileKey) return null;
    return `https://www.figma.com/design/${this.fileKey}/${slug(this.lastFileName)}?node-id=${encodeURIComponent(nodeId.replace(/:/g, "-"))}`;
  }
}
