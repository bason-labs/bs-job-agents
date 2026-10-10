import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TranscriptWriter } from "./transcript.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("TranscriptWriter (§5.5 step 3)", () => {
  it("creates the folder and appends raw CLI lines verbatim plus runner notes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bsja-transcript-"));
    dirs.push(dir);
    const path = join(dir, "transcripts", "42-1.jsonl");
    const t = await TranscriptWriter.open(path);
    t.raw('{"type":"system","subtype":"init"}');
    t.note({ type: "runner.stderr", text: "Reading additional input from stdin..." });
    await t.close();
    const t2 = await TranscriptWriter.open(path);
    t2.raw('{"type":"result"}');
    await t2.close();
    expect(readFileSync(path, "utf8").split("\n")).toEqual([
      '{"type":"system","subtype":"init"}',
      '{"type":"runner.stderr","text":"Reading additional input from stdin..."}',
      '{"type":"result"}',
      "",
    ]);
  });

  it("never writes a raw line that would break JSONL (embedded newlines are escaped)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bsja-transcript-"));
    dirs.push(dir);
    const path = join(dir, "t.jsonl");
    const t = await TranscriptWriter.open(path);
    t.raw("not json\nsecond");
    await t.close();
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    expect(lines).toEqual(['{"type":"runner.raw","text":"not json\\nsecond"}']);
  });

  it("fails to open when the path cannot be created", async () => {
    await expect(TranscriptWriter.open("/dev/null/nope/1.jsonl")).rejects.toThrow();
  });
});
