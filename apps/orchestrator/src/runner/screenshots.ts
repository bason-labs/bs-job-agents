// Screenshot capture (PM2 S7, decision 1b; spec §1.2 success 2, UC-11 steps 5–8, §9.1).
// The runner is the only party that sees a screenshot's bytes and is not a model: each image block
// in a Claude in Chrome tool result is written to <screenshotDir>/<n>.<png|jpg> (the engine names
// the folder: data/screenshots/<task>-<attempt>/), listed in manifest.json with the tool_use id, the
// screenshot id the tool showed ("… - ID: ss_…"), its hash and time, and returned in RunnerResult.
// The line that goes to the transcript (and to the stream parser) keeps a file reference instead of
// the base64 bytes (~400 KB per shot). Images from any other tool, bytes that are not a PNG or JPEG,
// and anything beyond the per-attempt cap are dropped from the line and never written.
// The engine then copies the screenshots Apply names (by id) into data/applications/<id>/ (§9.1).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const SCREENSHOT_MANIFEST = "manifest.json";
/** Files one attempt may write (resumed spawns of the attempt included). */
export const MAX_SCREENSHOTS_PER_ATTEMPT = 40;
/** A bigger image block is dropped (a viewport JPEG is ~400 KB). */
export const MAX_SCREENSHOT_BYTES = 15 * 1024 * 1024;
/** Only Claude in Chrome's tools produce screenshots worth keeping. */
export const SCREENSHOT_TOOL_PREFIX = "mcp__claude-in-chrome__";

const CapturedScreenshotSchema = z.object({
  /** 1, 2, … across the attempt. */
  n: z.number().int().positive(),
  /** File name inside the screenshot folder, e.g. "2.png". */
  file: z.string().regex(/^\d+\.(?:png|jpg)$/),
  /** The id the tool showed the bot, e.g. ss_7816fhx3w (Apply names its screenshots by it). */
  screenshotId: z.string().nullable(),
  toolUseId: z.string(),
  tool: z.string(),
  /** From the bytes, not from what the block claimed. */
  mediaType: z.enum(["image/png", "image/jpeg"]),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  capturedAt: z.string(),
});
export type CapturedScreenshot = z.infer<typeof CapturedScreenshotSchema>;

const ManifestSchema = z.object({ version: z.literal(1), screenshots: z.array(CapturedScreenshotSchema) });

/** The manifest's entries; anything unreadable or malformed is an empty list, never an error. */
export function readScreenshotManifest(text: string | null): CapturedScreenshot[] {
  if (!text) return [];
  try {
    const parsed = ManifestSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.screenshots : [];
  } catch {
    return [];
  }
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function imageKind(bytes: Buffer): { mediaType: CapturedScreenshot["mediaType"]; ext: "png" | "jpg" } | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= png.length && png.every((b, i) => bytes[i] === b)) return { mediaType: "image/png", ext: "png" };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mediaType: "image/jpeg", ext: "jpg" };
  return null;
}

/** The base64 data and claimed type of an image block (Anthropic or MCP form), or null. */
function imageData(block: unknown): { data: string; claimed: string | null } | null {
  if (!isObj(block) || block.type !== "image") return null;
  const source = isObj(block.source) ? block.source : null;
  if (source && source.type === "base64" && typeof source.data === "string") {
    return { data: source.data, claimed: typeof source.media_type === "string" ? source.media_type : null };
  }
  if (typeof block.data === "string") return { data: block.data, claimed: typeof block.mimeType === "string" ? block.mimeType : null };
  return null;
}

/** "Successfully captured screenshot (…) - ID: ss_x" → ["ss_x"]. */
function screenshotIds(blocks: readonly unknown[]): string[] {
  const ids: string[] = [];
  for (const b of blocks) {
    if (!isObj(b) || b.type !== "text" || typeof b.text !== "string") continue;
    for (const m of b.text.matchAll(/\bID:\s*([A-Za-z0-9_-]{1,64})/g)) ids.push(m[1]!);
  }
  return ids;
}

type Ref = Json;

export class ScreenshotCapture {
  /** This spawn's files, in order. */
  readonly captured: CapturedScreenshot[] = [];
  private readonly toolNames = new Map<string, string>();

  private constructor(
    private readonly dir: string | null,
    private readonly earlier: CapturedScreenshot[],
    private readonly now: () => number,
  ) {}

  /** `dir` null: nothing is kept, the bytes are only dropped from the transcript. */
  static async open(dir: string | null, opts: { now?: () => number } = {}): Promise<ScreenshotCapture> {
    let earlier: CapturedScreenshot[] = [];
    if (dir) {
      mkdirSync(dir, { recursive: true });
      const path = join(dir, SCREENSHOT_MANIFEST);
      earlier = existsSync(path) ? readScreenshotManifest(readFileSync(path, "utf8")) : [];
    }
    return new ScreenshotCapture(dir, earlier, opts.now ?? Date.now);
  }

  /** The line for the transcript and the stream parser: images replaced by references. */
  process(line: string): string {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("{")) return line;
    const hasImage = line.includes('"image"');
    if (!hasImage && !line.includes('"tool_use"')) return line;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return line;
    }
    if (!isObj(event)) return line;
    if (event.type === "assistant") this.rememberToolNames(event);
    if (!hasImage) return line;
    const refs = new Map<string, Ref>();
    let changed = false;
    if (event.type === "user") {
      const message = isObj(event.message) ? event.message : null;
      const results = Array.isArray(message?.content) ? message.content.filter((c): c is Json => isObj(c) && c.type === "tool_result") : [];
      for (const r of results) {
        if (!Array.isArray(r.content)) continue;
        const id = typeof r.tool_use_id === "string" ? r.tool_use_id : "";
        const tool = this.toolNames.get(id) ?? null;
        const out = this.rewriteBlocks(r.content, id, tool, refs);
        if (out !== r.content) {
          r.content = out;
          changed = true;
        }
      }
      // tool_use_result mirrors the single tool_result's content.
      if (Array.isArray(event.tool_use_result) && results.length === 1) {
        const id = typeof results[0]!.tool_use_id === "string" ? (results[0]!.tool_use_id as string) : "";
        const out = this.rewriteBlocks(event.tool_use_result, id, this.toolNames.get(id) ?? null, refs);
        if (out !== event.tool_use_result) {
          event.tool_use_result = out;
          changed = true;
        }
      }
    }
    // Any image left anywhere else (another engine's events, an odd shape): dropped, never kept.
    const rest = this.omitEverywhere(event);
    return changed || rest.changed ? JSON.stringify(rest.value) : line;
  }

  /** Writes the manifest (earlier spawns' entries plus this one's). */
  async finish(): Promise<void> {
    if (!this.dir || this.captured.length === 0) return;
    const path = join(this.dir, SCREENSHOT_MANIFEST);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, screenshots: [...this.earlier, ...this.captured] }, null, 2)}\n`);
    renameSync(tmp, path);
  }

  private rememberToolNames(event: Json): void {
    const message = isObj(event.message) ? event.message : null;
    for (const c of Array.isArray(message?.content) ? message.content : []) {
      if (isObj(c) && c.type === "tool_use" && typeof c.id === "string" && typeof c.name === "string") this.toolNames.set(c.id, c.name);
    }
  }

  private rewriteBlocks(blocks: unknown[], toolUseId: string, tool: string | null, refs: Map<string, Ref>): unknown[] {
    if (!blocks.some((b) => imageData(b) !== null)) return blocks;
    const ids = screenshotIds(blocks);
    let imageIndex = 0;
    return blocks.map((b) => {
      const img = imageData(b);
      if (!img) return b;
      const screenshotId = ids[imageIndex] ?? (ids.length === 1 ? ids[0]! : null);
      imageIndex++;
      return this.store(img, toolUseId, tool, screenshotId, refs);
    });
  }

  private store(img: { data: string; claimed: string | null }, toolUseId: string, tool: string | null, screenshotId: string | null, refs: Map<string, Ref>): Ref {
    const bytes = Buffer.from(img.data, "base64");
    const kind = imageKind(bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const known = refs.get(sha256);
    if (known) return known;
    const omitted: Ref = { type: "image", source: { type: "omitted", media_type: kind?.mediaType ?? img.claimed, bytes: bytes.length } };
    const keep =
      this.dir !== null &&
      kind !== null &&
      tool !== null &&
      tool.startsWith(SCREENSHOT_TOOL_PREFIX) &&
      bytes.length <= MAX_SCREENSHOT_BYTES &&
      this.earlier.length + this.captured.length < MAX_SCREENSHOTS_PER_ATTEMPT;
    if (!keep) {
      refs.set(sha256, omitted);
      return omitted;
    }
    const n = Math.max(0, ...this.earlier.map((c) => c.n), ...this.captured.map((c) => c.n)) + 1;
    const file = `${n}.${kind.ext}`;
    // A new name every time (never over an existing path): `wx` refuses to follow or replace anything.
    writeFileSync(join(this.dir!, file), bytes, { flag: "wx" });
    const entry: CapturedScreenshot = {
      n,
      file,
      screenshotId,
      toolUseId,
      tool,
      mediaType: kind.mediaType,
      bytes: bytes.length,
      sha256,
      capturedAt: new Date(this.now()).toISOString(),
    };
    this.captured.push(entry);
    const ref: Ref = { type: "image", source: { type: "file", file, media_type: kind.mediaType, bytes: bytes.length, screenshotId } };
    refs.set(sha256, ref);
    return ref;
  }

  private omitEverywhere(value: unknown): { value: unknown; changed: boolean } {
    const img = imageData(value);
    if (img) {
      const bytes = Buffer.from(img.data, "base64");
      return { value: { type: "image", source: { type: "omitted", media_type: imageKind(bytes)?.mediaType ?? img.claimed, bytes: bytes.length } }, changed: true };
    }
    if (Array.isArray(value)) {
      let changed = false;
      const out = value.map((v) => {
        const r = this.omitEverywhere(v);
        changed ||= r.changed;
        return r.value;
      });
      return changed ? { value: out, changed } : { value, changed };
    }
    if (isObj(value)) {
      let changed = false;
      const out: Json = {};
      for (const [k, v] of Object.entries(value)) {
        const r = this.omitEverywhere(v);
        changed ||= r.changed;
        out[k] = r.value;
      }
      return changed ? { value: out, changed } : { value, changed };
    }
    return { value, changed: false };
  }
}
