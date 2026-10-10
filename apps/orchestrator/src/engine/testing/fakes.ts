// Fake bridges and stores for engine tests (rule 1: never call real CLIs, Chrome or Figma).
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
import type {
  BotRegistry,
  BrowserStatusProbe,
  FigmaBridge,
  FileStore,
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

  read(path: string): string | undefined {
    return this.files.get(path)?.toString("utf8");
  }

  async copy(from: string, to: string): Promise<void> {
    const bytes = this.files.get(from);
    if (!bytes) throw Object.assign(new Error(`ENOENT: no such file, copy '${from}'`), { code: "ENOENT" });
    this.copies.push({ from, to });
    this.files.set(to, this.tamper ? this.tamper(from, to, Buffer.from(bytes)) : Buffer.from(bytes));
  }

  async sha256(path: string): Promise<string> {
    const bytes = this.files.get(path);
    if (!bytes) throw Object.assign(new Error(`ENOENT: no such file '${path}'`), { code: "ENOENT" });
    return createHash("sha256").update(bytes).digest("hex");
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  static sha256Of(content: string | Buffer): string {
    return createHash("sha256").update(Buffer.from(content)).digest("hex");
  }
}

/** Chrome + extension status per engine; flip it to test needs_browser waits. */
export class FakeBrowserProbe implements BrowserStatusProbe {
  readonly connected: Record<Engine, boolean> = { claude: true, codex: true };
  checks = 0;

  set(engine: Engine | "all", connected: boolean): void {
    if (engine === "all") this.connected.claude = this.connected.codex = connected;
    else this.connected[engine] = connected;
  }

  async isConnected(engine: Engine): Promise<boolean> {
    this.checks++;
    return this.connected[engine];
  }
}

/** The Figma bridge: status, protected-page fingerprint and PDF export into a MemoryFileStore. */
export class FakeFigmaBridge implements FigmaBridge {
  connected = true;
  fingerprint = "protected-pages-v1";
  /** Pages per exported PDF (UC-06 a: a CV that spills onto a second page fails the attempt). */
  pageCount = 1;
  exportError: string | null = null;
  readonly exports: { frameName: string; outPath: string; sha256: string }[] = [];
  /** Called during an export, e.g. to change the protected pages mid-task. */
  onExport: ((frameName: string) => void) | null = null;

  constructor(private readonly files: MemoryFileStore) {}

  async status(): Promise<{ connected: boolean }> {
    return { connected: this.connected };
  }

  async fingerprintProtectedPages(): Promise<string> {
    return this.fingerprint;
  }

  async exportFramePdf(input: { frameName: string; outPath: string }): Promise<{ sha256: string; pageCount: number }> {
    this.onExport?.(input.frameName);
    if (this.exportError) throw new Error(this.exportError);
    const content = `%PDF-1.7 fake export of ${input.frameName}`;
    this.files.write(input.outPath, content);
    const sha256 = MemoryFileStore.sha256Of(content);
    this.exports.push({ ...input, sha256 });
    return { sha256, pageCount: this.pageCount };
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
