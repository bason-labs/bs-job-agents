import { TranscriptLineSchema } from "@bs-job-agents/shared";
import { describe, expect, it } from "vitest";
import type { ProgressLine } from "./contract";
import { fromProgress, fromSaved, mergeTranscript, toSavedLines } from "./transcript";

const at = "2026-10-10T09:00:00+07:00";
const progress: ProgressLine[] = [
  { at, kind: "status", text: "task started", tool: null },
  { at, kind: "tool_use", text: "Opening TopCV", tool: "cua_repl" },
  { at, kind: "tool_result", text: "ok", tool: "cua_repl" },
  { at, kind: "text", text: "Found 12 jobs", tool: null },
];

describe("step drawer transcript (UC-22)", () => {
  it("saved lines follow the shared TranscriptLine schema", () => {
    const saved = toSavedLines(progress);
    for (const l of saved) expect(TranscriptLineSchema.safeParse(l).success).toBe(true);
    expect(saved.map((l) => [l.n, l.kind])).toEqual([
      [1, "system"],
      [2, "tool"],
      [3, "tool_result"],
      [4, "text"],
    ]);
  });

  it("saved and live lines render alike", () => {
    expect(toSavedLines(progress).map(fromSaved)).toEqual(progress.map(fromProgress));
    expect(fromSaved({ n: 9, kind: "runner", text: "attempt 1 timed out" })).toEqual({ kind: "status", text: "attempt 1 timed out" });
  });

  it("a live line already saved is shown once; new live lines follow", () => {
    const saved = toSavedLines(progress.slice(0, 2));
    const merged = mergeTranscript(saved, progress);
    expect(merged.map((l) => l.text)).toEqual(["task started", "cua_repl — Opening TopCV", "cua_repl — ok", "Found 12 jobs"]);
  });
});
