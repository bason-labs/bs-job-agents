import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendMemoryNotes, formatMemoryLine } from "./memory.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bsja-memory-"));
  writeFileSync(join(dir, "memory.md"), "");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NOW = new Date(2026, 9, 11, 9, 30);
const lines = (file = "memory.md") => readFileSync(join(dir, file), "utf8").split("\n").filter(Boolean);

describe("appendMemoryNotes (§5.4, rule 2)", () => {
  it("appends each note as one dated line with run and task", async () => {
    const r = await appendMemoryNotes({ botDir: dir, notes: ["TopCV upload limit is 5MB"], runId: 12, taskId: 40, now: NOW });
    expect(r).toEqual({ appended: ["TopCV upload limit is 5MB"], archived: 0 });
    expect(lines()).toEqual(["- 2026-10-11 · run 12 · task 40: TopCV upload limit is 5MB"]);
    expect(formatMemoryLine("x", { runId: null, taskId: 3, now: NOW })).toBe("- 2026-10-11 · task 3: x");
  });

  it("writes one note at a time and calls onNote after each write (for memory_changes)", async () => {
    const seen: number[] = [];
    await appendMemoryNotes({
      botDir: dir,
      notes: ["a", "b", "c"],
      runId: 1,
      taskId: 2,
      now: NOW,
      onNote: () => {
        seen.push(lines().length);
      },
    });
    expect(seen).toEqual([1, 2, 3]);
  });

  it("serialises concurrent appends for the same bot (no lost lines)", async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => appendMemoryNotes({ botDir: dir, notes: [`note ${i}`], runId: null, taskId: i, now: NOW })));
    expect(lines()).toHaveLength(12);
  });

  it("flattens whitespace, caps length, skips empty notes and exact repeats", async () => {
    const r = await appendMemoryNotes({
      botDir: dir,
      notes: ["  line one\nline two  ", "", "x".repeat(400), "line one line two"],
      runId: 1,
      taskId: 1,
      now: NOW,
    });
    expect(r.appended).toEqual(["line one line two", "x".repeat(300)]);
    expect(lines()).toHaveLength(2);
  });

  it("archives the oldest lines beyond 200 to memory.archive.md", async () => {
    writeFileSync(join(dir, "memory.md"), `${Array.from({ length: 200 }, (_, i) => `- old ${i}`).join("\n")}\n`);
    const r = await appendMemoryNotes({ botDir: dir, notes: ["new one", "new two"], runId: 1, taskId: 1, now: NOW });
    expect(r.archived).toBe(2);
    expect(lines()).toHaveLength(200);
    expect(lines()[0]).toBe("- old 2");
    expect(lines().at(-1)).toMatch(/new two$/);
    expect(lines("memory.archive.md")).toEqual(["- old 0", "- old 1"]);
  });

  it("creates memory.md when it is missing", async () => {
    rmSync(join(dir, "memory.md"));
    await appendMemoryNotes({ botDir: dir, notes: ["first"], runId: null, taskId: null, now: NOW });
    expect(existsSync(join(dir, "memory.md"))).toBe(true);
    expect(lines()).toEqual(["- 2026-10-11: first"]);
  });
});
