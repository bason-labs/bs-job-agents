// Fake bridges and stores for engine tests (rule 1: never call real CLIs, Chrome or Figma). The
// Figma fake builds real ProtectedPagesFingerprint objects with W2c's pure buildFingerprint, so
// the engine's diff runs W2c's real diffFingerprints.
import { createHash } from "node:crypto";
import {
  BotDefinitionSchema,
  WorkflowDefinitionSchema,
  type BotDefinition,
  type BotDefinitionInput,
  type Engine,
  type WorkflowDefinition,
  type WorkflowDefinitionInput,
} from "@bs-job-agents/shared";
import { applyToFileWorkflow, applyToLinkWorkflow, botDefinitionFixtures, jobScanWorkflow } from "@bs-job-agents/shared/fixtures";
import { FigmaBridgeError } from "../../bridges/figma/errors.js";
import { buildFingerprint, type PageSnapshot, type ProtectedPagesFingerprint } from "../../bridges/figma/fingerprint.js";
import type { ClaudeHookSettings } from "../../bridges/hooks/settings.js";
import type {
  BotRegistry,
  BrowserStatusProbe,
  FigmaPort,
  FileStore,
  FramePdfExport,
  GuardHooks,
  MasterCvSource,
  PdfTextExtractor,
  WorkflowSource,
} from "../ports.js";

/** An in-memory FileStore; `tamper` changes what a copy writes (SHA-256 mismatch tests). */
export class MemoryFileStore implements FileStore {
  readonly files = new Map<string, Buffer>();
  readonly copies: { from: string; to: string }[] = [];
  /** Rewrites the bytes of a copy, e.g. to simulate the approved PDF changing on disk. */
  tamper: ((from: string, to: string, bytes: Buffer) => Buffer) | null = null;

  write(path: string, content: string | Buffer): void {
    this.files.set(path, Buffer.from(content));
  }

  append(path: string, content: string): void {
    this.files.set(path, Buffer.concat([this.files.get(path) ?? Buffer.alloc(0), Buffer.from(content)]));
  }

  read(path: string): string | undefined {
    return this.files.get(path)?.toString("utf8");
  }

  async copy(from: string, to: string): Promise<void> {
    const bytes = this.files.get(from);
    if (!bytes) throw Object.assign(new Error(`ENOENT: no such file, copy '${from}'`), { code: "ENOENT" });
    this.copies.push({ from, to });
    this.files.set(to, this.tamper ? this.tamper(from, to, Buffer.from(bytes)) : Buffer.from(bytes));
  }

  async copyVerified(from: string, to: string, expectedSha256: string): Promise<{ sha256: string }> {
    await this.copy(from, to);
    const sha256 = await this.sha256(to);
    if (sha256 !== expectedSha256) {
      this.files.delete(to);
      throw Object.assign(new Error(`SHA-256 of ${to} is ${sha256}, expected ${expectedSha256}`), { name: "Sha256MismatchError" });
    }
    return { sha256 };
  }

  async sha256(path: string): Promise<string> {
    const bytes = this.files.get(path);
    if (!bytes) throw Object.assign(new Error(`ENOENT: no such file '${path}'`), { code: "ENOENT" });
    return createHash("sha256").update(bytes).digest("hex");
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async readText(path: string): Promise<string | null> {
    return this.read(path) ?? null;
  }

  async writeText(path: string, text: string): Promise<void> {
    this.write(path, text);
  }

  async readHead(path: string, bytes: number, _within?: string): Promise<Buffer | null> {
    const content = this.files.get(path);
    return content ? Buffer.from(content.subarray(0, bytes)) : null;
  }

  static sha256Of(content: string | Buffer): string {
    return createHash("sha256").update(Buffer.from(content)).digest("hex");
  }
}

/** Chrome + extension status per engine; flip it to test needs_browser waits. */
export class FakeBrowserProbe implements BrowserStatusProbe {
  readonly connected: Record<Engine, boolean> = { claude: true, codex: true };
  checks = 0;
  private held: Promise<void> | null = null;

  set(engine: Engine | "all", connected: boolean): void {
    if (engine === "all") this.connected.claude = this.connected.codex = connected;
    else this.connected[engine] = connected;
  }

  /** Make the next checks wait until the returned function is called (a task stays in its checks). */
  hold(): () => void {
    let release!: () => void;
    this.held = new Promise<void>((resolve) => (release = resolve));
    return () => {
      this.held = null;
      release();
    };
  }

  async isConnected(engine: Engine): Promise<boolean> {
    this.checks++;
    if (this.held) await this.held;
    return this.connected[engine];
  }
}

const TEMPLATE_PAGE: PageSnapshot = {
  id: "1:1",
  name: "resume",
  nodes: [
    { id: "459:1767", type: "FRAME", name: "BA HUYNH — Software Engineer Resume | Refreshed", parentId: "1:1", index: 0, w: 595, h: 842 },
    { id: "459:1800", type: "TEXT", name: "Professional title", parentId: "459:1767", index: 0, text: "Software Engineer" },
  ],
};

/**
 * The orchestrator's Figma connection (W2c FigmaBridge shape). CV frames the fake CV bot "made"
 * are found by name on the Drafts page; exports write a fake PDF into the MemoryFileStore.
 */
export class FakeFigmaPort implements FigmaPort {
  connected = true;
  message = "Open Figma desktop with the CV file and run Plugins → Development → Figma Desktop Bridge.";
  /** The protected pages as they are now; edit to simulate a change. */
  pages: PageSnapshot[] = [structuredClone(TEMPLATE_PAGE)];
  /** Pages per exported PDF and the A4 check (UC-06 a). */
  pageCount = 1;
  onePageA4 = true;
  /** Frames missing from Drafts (the bot claimed a frame that is not there). */
  missingFrames = new Set<string>();
  exportError: Error | null = null;
  /** Figma disappears for the orchestrator's next call (isFigmaUnavailable → needs_figma). */
  unavailableOnce: "ensureDraftsPage" | "fingerprint" | "export" | null = null;
  readonly exports: { frameId: string; frameName: string; outPath: string; sha256: string }[] = [];
  readonly calls: string[] = [];
  private fingerprints = 0;

  constructor(private readonly files: MemoryFileStore) {}

  private gone(call: "ensureDraftsPage" | "fingerprint" | "export"): void {
    if (this.unavailableOnce === call) {
      this.unavailableOnce = null;
      throw new FigmaBridgeError("not_connected", "Figma closed during the call");
    }
  }

  async status(): Promise<{ connected: boolean; message: string }> {
    this.calls.push("status");
    return { connected: this.connected, message: this.connected ? "Figma is connected." : this.message };
  }

  async ensureDraftsPage(): Promise<{ id: string; name: string }> {
    this.calls.push("ensureDraftsPage");
    this.gone("ensureDraftsPage");
    return { id: "900:1", name: "Drafts" };
  }

  async fingerprintProtectedPages(): Promise<ProtectedPagesFingerprint> {
    this.calls.push("fingerprint");
    this.gone("fingerprint");
    this.fingerprints++;
    return buildFingerprint({
      fileKey: "kJFoXNrTfFOtkQ515c0jHk",
      draftsPageName: "Drafts",
      pages: structuredClone(this.pages),
      resources: { styles: 3 },
      takenAt: new Date(Date.UTC(2026, 9, 10, 8, 0, this.fingerprints)).toISOString(),
    });
  }

  async findDraftFrame(name: string): Promise<{ id: string; name: string; url: string | null } | null> {
    this.calls.push(`findDraftFrame:${name}`);
    if (this.missingFrames.has(name)) return null;
    const id = `901:${createHash("sha256").update(name).digest("hex").slice(0, 6)}`;
    return { id, name, url: `https://www.figma.com/design/kJFoXNrTfFOtkQ515c0jHk?node-id=${id.replace(":", "-")}` };
  }

  async exportFramePdf(frameId: string, outPath: string): Promise<FramePdfExport> {
    this.calls.push(`export:${frameId}`);
    this.gone("export");
    if (this.exportError) throw this.exportError;
    const content = `%PDF-1.7 fake export of ${frameId} to ${outPath}`;
    this.files.write(outPath, content);
    const sha256 = MemoryFileStore.sha256Of(content);
    this.exports.push({ frameId, frameName: outPath.split("/").at(-1)!.replace(/\.pdf$/, ""), outPath, sha256 });
    const size = this.onePageA4 ? { widthPt: 595.28, heightPt: 841.89 } : { widthPt: 612, heightPt: 792 };
    return { sha256, pageCount: this.pageCount, onePageA4: this.onePageA4, ...size };
  }

  /** Simulate the CV bot (or anything) changing a protected page. */
  changeProtectedText(text: string): void {
    const node = this.pages[0]!.nodes.find((n) => n.type === "TEXT")!;
    node.text = text;
  }
}

/** Guard hooks as plain marker objects; tests write guard log lines with `logBlock`. */
export class FakeGuardHooks implements GuardHooks {
  readonly siteCalls: { allowedSites: readonly string[]; logFile: string }[] = [];
  readonly figmaCalls: { dir: string; logFile: string; draftsPageId: string | null; fingerprintHash: string }[] = [];

  constructor(private readonly files: MemoryFileStore) {}

  siteGuard(opts: { allowedSites: readonly string[]; logFile: string }): ClaudeHookSettings {
    this.siteCalls.push({ allowedSites: [...opts.allowedSites], logFile: opts.logFile });
    return {
      hooks: {
        PreToolUse: [{ matcher: "mcp__claude-in-chrome__navigate", hooks: [{ type: "command", command: `site-guard --allow ${opts.allowedSites.join(",")} --log ${opts.logFile}` }] }],
      },
    };
  }

  async figmaGuard(opts: { fingerprint: ProtectedPagesFingerprint; dir: string; logFile: string; draftsPageId: string | null }): Promise<ClaudeHookSettings> {
    this.figmaCalls.push({ dir: opts.dir, logFile: opts.logFile, draftsPageId: opts.draftsPageId, fingerprintHash: opts.fingerprint.hash });
    return {
      hooks: {
        PreToolUse: [{ matcher: "mcp__figma__.*", hooks: [{ type: "command", command: `figma-guard --config ${opts.dir}/figma-guard.json --log ${opts.logFile}` }] }],
      },
    };
  }

  /** What a guard hook writes when it blocks a call (bridges/hooks/run.ts). */
  logBlock(logFile: string, block: { guard: "site" | "figma"; tool: string; rule: string; reason: string; target?: string }): void {
    this.files.append(logFile, `${JSON.stringify({ ts: "2026-10-10T08:00:00.000Z", decision: "block", ...block })}\n`);
  }
}

export class FakePdfText implements PdfTextExtractor {
  async extractText(path: string): Promise<string> {
    return `Ba Huynh\nSoftware Engineer\n(text of ${path})`;
  }
}

export class FakeMasterCv implements MasterCvSource {
  current: number | null = 3;

  constructor(
    readonly path: string,
    files?: MemoryFileStore,
  ) {
    files?.write(path, "version: 3\nfacts:\n  - id: grad-1\n    type: experience\n    text: Owned a React/Node.js app\n");
  }

  version(): number | null {
    return this.current;
  }
}

/** A BotRegistry over fixed definitions (the shared fixtures by default). */
export function staticBotRegistry(defs: readonly BotDefinitionInput[] = botDefinitionFixtures): BotRegistry {
  const parsed = new Map<string, BotDefinition>(defs.map((d) => [d.name, BotDefinitionSchema.parse(d)]));
  return { get: (name) => parsed.get(name), list: () => [...parsed.values()] };
}

/** A WorkflowSource over definitions (the §7.2–7.3b fixtures by default). */
export function staticWorkflowSource(
  defs: readonly WorkflowDefinitionInput[] = [jobScanWorkflow, applyToLinkWorkflow, applyToFileWorkflow],
): WorkflowSource {
  const parsed: WorkflowDefinition[] = defs.map((d) => WorkflowDefinitionSchema.parse(d));
  return {
    get(name, version) {
      const versions = parsed.filter((d) => d.name === name && (version === undefined || d.version === version));
      return versions.sort((a, b) => b.version - a.version)[0];
    },
  };
}
