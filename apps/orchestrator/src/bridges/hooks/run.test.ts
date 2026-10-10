import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuardDecision, PreToolUseCall } from "./protocol.js";
import { runPreToolUseHook } from "./run.js";

function io(stdin: string) {
  const err: string[] = [];
  return {
    streams: { stdin: Readable.from([Buffer.from(stdin)]), stderr: { write: (s: string) => err.push(s) } },
    stderr: () => err.join(""),
  };
}

const input = (toolName: string, toolInput: unknown = {}) =>
  JSON.stringify({
    session_id: "s1",
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: "toolu_1",
  });

const allow = (): GuardDecision => ({ allow: true });
const block = (): GuardDecision => ({ allow: false, rule: "test_rule", reason: "Blocked by test guard: nope", target: "x" });

describe("runPreToolUseHook", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bridges-hook-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("exits 0 silently when the guard allows, and passes the parsed call", async () => {
    const evaluate = vi.fn<(call: PreToolUseCall) => GuardDecision>(allow);
    const t = io(input("mcp__x__navigate", { url: "https://topcv.vn" }));
    await expect(runPreToolUseHook(evaluate, t.streams, { guard: "test" })).resolves.toBe(0);
    expect(t.stderr()).toBe("");
    const call = evaluate.mock.calls[0]?.[0];
    expect(call).toMatchObject({ toolName: "mcp__x__navigate", toolInput: { url: "https://topcv.vn" }, sessionId: "s1" });
  });

  it("exits 2 with the reason on stderr when the guard blocks", async () => {
    const t = io(input("mcp__x__navigate"));
    await expect(runPreToolUseHook(block, t.streams, { guard: "test" })).resolves.toBe(2);
    expect(t.stderr()).toBe("Blocked by test guard: nope\n");
  });

  it("fails closed on input that is not JSON", async () => {
    const t = io("{not json");
    await expect(runPreToolUseHook(allow, t.streams, { guard: "test" })).resolves.toBe(2);
    expect(t.stderr()).toMatch(/test guard: could not read the hook input/);
  });

  it("fails closed when tool_name is missing", async () => {
    const t = io(JSON.stringify({ hook_event_name: "PreToolUse", tool_input: {} }));
    await expect(runPreToolUseHook(allow, t.streams, { guard: "test" })).resolves.toBe(2);
  });

  it("fails closed when the evaluator throws", async () => {
    const t = io(input("mcp__x__navigate"));
    const boom = () => {
      throw new Error("kaboom");
    };
    await expect(runPreToolUseHook(boom, t.streams, { guard: "test" })).resolves.toBe(2);
    expect(t.stderr()).toMatch(/test guard failed: kaboom/);
  });

  it("fails closed on oversized input", async () => {
    const t = io(input("mcp__x__javascript_tool", { text: "x".repeat(2000) }));
    await expect(runPreToolUseHook(allow, t.streams, { guard: "test", maxInputBytes: 1000 })).resolves.toBe(2);
    expect(t.stderr()).toMatch(/too large/);
  });

  it("treats a non-object tool_input as empty", async () => {
    const evaluate = vi.fn<(call: PreToolUseCall) => GuardDecision>(allow);
    const t = io(input("mcp__x__navigate", "weird"));
    await runPreToolUseHook(evaluate, t.streams, { guard: "test" });
    expect(evaluate.mock.calls[0]?.[0]?.toolInput).toEqual({});
  });

  it("lets other hook events through untouched", async () => {
    const evaluate = vi.fn<(call: PreToolUseCall) => GuardDecision>(block);
    const t = io(JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "mcp__x__navigate", tool_input: {} }));
    await expect(runPreToolUseHook(evaluate, t.streams, { guard: "test" })).resolves.toBe(0);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("appends one JSON line per decision to the log file", async () => {
    const logFile = join(dir, "nested", "guard.jsonl");
    const now = () => new Date("2026-10-11T01:02:03.000Z");
    await runPreToolUseHook(allow, io(input("mcp__x__navigate")).streams, { guard: "test", logFile, now });
    await runPreToolUseHook(block, io(input("mcp__x__navigate")).streams, { guard: "test", logFile, now });
    const lines = (await readFile(logFile, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toEqual([
      { ts: "2026-10-11T01:02:03.000Z", guard: "test", tool: "mcp__x__navigate", decision: "allow", sessionId: "s1", toolUseId: "toolu_1" },
      {
        ts: "2026-10-11T01:02:03.000Z",
        guard: "test",
        tool: "mcp__x__navigate",
        decision: "block",
        rule: "test_rule",
        reason: "Blocked by test guard: nope",
        target: "x",
        sessionId: "s1",
        toolUseId: "toolu_1",
      },
    ]);
  });

  it("still decides when the log file cannot be written", async () => {
    const logFile = join(dir, "file-not-dir");
    await runPreToolUseHook(allow, io(input("a")).streams, { guard: "test", logFile });
    // logFile is now a file, so a log path below it cannot be created.
    const t = io(input("mcp__x__navigate"));
    await expect(runPreToolUseHook(block, t.streams, { guard: "test", logFile: join(logFile, "x.jsonl") })).resolves.toBe(2);
    const t2 = io(input("mcp__x__navigate"));
    await expect(runPreToolUseHook(allow, t2.streams, { guard: "test", logFile: join(logFile, "x.jsonl") })).resolves.toBe(0);
  });
});
