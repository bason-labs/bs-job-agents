import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JPEG_BYTES, PNG_BYTES, screenshotLines } from "./__fixtures__/screenshots.js";
import { MAX_SCREENSHOTS_PER_ATTEMPT, SCREENSHOT_MANIFEST, ScreenshotCapture, readScreenshotManifest } from "./screenshots.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bsja-shots-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const NOW = Date.parse("2026-10-11T03:00:00.000Z");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const dir = () => join(root, "screenshots", "42-1");

/** Feed lines through a capture; returns what the transcript would get. */
function feed(capture: ScreenshotCapture, lines: string[]): string[] {
  return lines.map((l) => capture.process(l));
}

describe("ScreenshotCapture (PM2 S7)", () => {
  it("two Chrome screenshots → two files and a manifest; the lines keep a file reference, not base64", async () => {
    const capture = await ScreenshotCapture.open(dir(), { now: () => NOW });
    const out = feed(capture, [
      ...screenshotLines({ toolUseId: "toolu_1", screenshotId: "ss_pre1", bytes: JPEG_BYTES }),
      ...screenshotLines({ toolUseId: "toolu_2", screenshotId: "ss_conf2", bytes: PNG_BYTES }),
    ]);
    await capture.finish();
    expect(readdirSync(dir()).sort()).toEqual(["1.jpg", "2.png", SCREENSHOT_MANIFEST]);
    expect(readFileSync(join(dir(), "1.jpg"))).toEqual(JPEG_BYTES);
    expect(readFileSync(join(dir(), "2.png"))).toEqual(PNG_BYTES);
    const expected = [
      { n: 1, file: "1.jpg", screenshotId: "ss_pre1", toolUseId: "toolu_1", tool: "mcp__claude-in-chrome__computer", mediaType: "image/jpeg", bytes: JPEG_BYTES.length, sha256: sha(JPEG_BYTES), capturedAt: "2026-10-11T03:00:00.000Z" },
      { n: 2, file: "2.png", screenshotId: "ss_conf2", toolUseId: "toolu_2", tool: "mcp__claude-in-chrome__computer", mediaType: "image/png", bytes: PNG_BYTES.length, sha256: sha(PNG_BYTES), capturedAt: "2026-10-11T03:00:00.000Z" },
    ];
    expect(capture.captured).toEqual(expected);
    expect(readScreenshotManifest(readFileSync(join(dir(), SCREENSHOT_MANIFEST), "utf8"))).toEqual(expected);
    // The transcript keeps a reference instead of the bytes (in message.content and tool_use_result).
    const joined = out.join("\n");
    expect(joined).not.toContain(JPEG_BYTES.toString("base64"));
    expect(joined).not.toContain(PNG_BYTES.toString("base64"));
    const user = JSON.parse(out[1]!) as { message: { content: Array<{ content: unknown[] }> }; tool_use_result: unknown[] };
    expect(user.message.content[0]!.content[1]).toEqual({ type: "image", source: { type: "file", file: "1.jpg", media_type: "image/jpeg", bytes: JPEG_BYTES.length, screenshotId: "ss_pre1" } });
    expect(user.tool_use_result[1]).toEqual(user.message.content[0]!.content[1]);
    expect(user.message.content[0]!.content[0]).toMatchObject({ type: "text" });
  });

  it("with no screenshot folder (a task that keeps none) the bytes are dropped from the transcript", async () => {
    const capture = await ScreenshotCapture.open(null, { now: () => NOW });
    const out = feed(capture, screenshotLines({ toolUseId: "toolu_1", screenshotId: "ss_1", bytes: PNG_BYTES }));
    await capture.finish();
    expect(capture.captured).toEqual([]);
    expect(out.join("\n")).not.toContain(PNG_BYTES.toString("base64"));
    const user = JSON.parse(out[1]!) as { message: { content: Array<{ content: unknown[] }> } };
    expect(user.message.content[0]!.content[1]).toEqual({ type: "image", source: { type: "omitted", media_type: "image/png", bytes: PNG_BYTES.length } });
  });

  it("only Chrome tools' images are kept (a Figma screenshot is dropped), and only real PNG or JPEG bytes", async () => {
    const capture = await ScreenshotCapture.open(dir(), { now: () => NOW });
    feed(capture, [
      ...screenshotLines({ toolUseId: "toolu_f", tool: "mcp__figma__figma_capture_screenshot", screenshotId: null, bytes: PNG_BYTES }),
      ...screenshotLines({ toolUseId: "toolu_x", screenshotId: "ss_fake", bytes: Buffer.from("not an image at all"), mediaType: "image/png" }),
      ...screenshotLines({ toolUseId: "toolu_ok", screenshotId: "ss_ok", bytes: PNG_BYTES, mediaType: "image/jpeg" }),
    ]);
    await capture.finish();
    // The claimed media type does not matter: the bytes are a PNG.
    expect(capture.captured.map((c) => [c.file, c.screenshotId, c.mediaType])).toEqual([["1.png", "ss_ok", "image/png"]]);
  });

  it("a resumed spawn of the same attempt continues the numbering and keeps the earlier entries", async () => {
    const first = await ScreenshotCapture.open(dir(), { now: () => NOW });
    feed(first, screenshotLines({ toolUseId: "toolu_1", screenshotId: "ss_a", bytes: PNG_BYTES }));
    await first.finish();
    const second = await ScreenshotCapture.open(dir(), { now: () => NOW });
    feed(second, screenshotLines({ toolUseId: "toolu_9", screenshotId: "ss_b", bytes: JPEG_BYTES }));
    await second.finish();
    expect(second.captured.map((c) => c.file)).toEqual(["2.jpg"]);
    expect(readScreenshotManifest(readFileSync(join(dir(), SCREENSHOT_MANIFEST), "utf8")).map((c) => c.screenshotId)).toEqual(["ss_a", "ss_b"]);
  });

  it("caps the number of files per attempt; the rest are dropped from the transcript", async () => {
    const capture = await ScreenshotCapture.open(dir(), { now: () => NOW });
    for (let i = 0; i < MAX_SCREENSHOTS_PER_ATTEMPT + 2; i++) feed(capture, screenshotLines({ toolUseId: `toolu_${i}`, screenshotId: `ss_${i}`, bytes: PNG_BYTES }));
    await capture.finish();
    expect(capture.captured).toHaveLength(MAX_SCREENSHOTS_PER_ATTEMPT);
    expect(existsSync(join(dir(), `${MAX_SCREENSHOTS_PER_ATTEMPT + 1}.png`))).toBe(false);
  });

  it("other lines pass through unchanged", async () => {
    const capture = await ScreenshotCapture.open(dir(), { now: () => NOW });
    const lines = ['{"type":"system","subtype":"init"}', "not json", '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"x","content":"plain"}]}}'];
    expect(feed(capture, lines)).toEqual(lines);
  });

  it("a corrupt manifest is read as empty, never as an error", () => {
    expect(readScreenshotManifest("{nope")).toEqual([]);
    expect(readScreenshotManifest(JSON.stringify({ version: 1, screenshots: [{ n: 1, file: "../../etc/passwd" }] }))).toEqual([]);
  });
});
