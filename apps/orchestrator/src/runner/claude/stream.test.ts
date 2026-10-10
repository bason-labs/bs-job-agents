import { describe, expect, it } from "vitest";
import { claudeLines } from "../__fixtures__/index.js";
import type { RunnerEvent } from "../types.js";
import { ClaudeStreamParser } from "./stream.js";

function parse(lines: readonly string[], pid: number | null = 4242) {
  const parser = new ClaudeStreamParser({ pid });
  const events: RunnerEvent[] = [];
  for (const line of lines) events.push(...parser.push(line));
  return { parser, events };
}

const toolEvents = (events: RunnerEvent[]) =>
  events.filter((e): e is Extract<RunnerEvent, { type: "tool" }> => e.type === "tool").map((e) => `${e.name}:${e.status}`);

describe("ClaudeStreamParser on real stream-json captures", () => {
  it("structured-ok: started, usage, structured_output; StructuredOutput is not a tool event", () => {
    const { parser, events } = parse(claudeLines("structuredOk"));
    expect(events[0]).toEqual({ type: "started", engine: "claude", sessionId: "672a22e9-efad-4750-93c8-0fabbbf6a898", pid: 4242 });
    expect(events.filter((e) => e.type === "usage")).toEqual([
      { type: "usage", engine: "claude", usage: { fiveHour: 0.28, sevenDay: 0.22, resetsAt: "2026-10-10T20:40:00.000Z" }, limited: false },
    ]);
    expect(toolEvents(events)).toEqual([]);
    expect(parser.sessionId).toBe("672a22e9-efad-4750-93c8-0fabbbf6a898");
    expect(parser.result).toMatchObject({ isError: false, subtype: "success", numTurns: 2 });
    expect(parser.structuredOutput).toEqual({
      reply: "I run on Claude Haiku 5.5 (model ID claude-haiku-5-5).",
      handoffToLead: null,
      selfCheck: [{ item: "Answered within my role; no work was done", passed: true, note: null }],
      memoryNotes: [],
    });
    expect(parser.realDenials()).toEqual([]);
    expect(parser.limit).toBeNull();
    expect(parser.initTools).toEqual(["StructuredOutput"]);
  });

  it("permission-denied: tool events and exactly one real denial (the errored read is not one)", () => {
    const { parser, events } = parse(claudeLines("permissionDenied"));
    expect(toolEvents(events)).toEqual([
      "Read:started",
      "Read:denied",
      "Read:started",
      "Read:error",
      "Read:started",
      "Read:done",
      "Read:started",
      "Read:done",
    ]);
    const denials = parser.realDenials();
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({ tool: "Read", source: "permission" });
    expect((denials[0]!.input as { file_path: string }).file_path).toMatch(/outside\/secret\.txt$/);
    expect(denials[0]!.reason).toMatch(/Permission for this tool use was denied/);
  });

  it("mcp-and-hook-denied: an MCP tool outside --allowedTools and a PreToolUse hook block are both real", () => {
    const { parser, events } = parse(claudeLines("mcpAndHookDenied"));
    expect(toolEvents(events)).toEqual([
      "mcp__echo__echo:started",
      "mcp__echo__echo:done",
      "mcp__echo__wipe:started",
      "mcp__echo__wipe:denied",
      "Read:started",
      "Read:denied",
      "Read:started",
      "Read:done",
    ]);
    const denials = parser.realDenials();
    expect(denials.map((d) => [d.tool, d.source])).toEqual([
      ["mcp__echo__wipe", "permission"],
      ["Read", "hook"],
    ]);
    expect(denials[1]!.reason).toMatch(/site guard/);
    expect(parser.mcpServers).toEqual([{ name: "echo", status: "connected" }]);
  });

  it("does not count a listed call whose tool_result shows it ran and errored (spike S1 cross-check)", () => {
    const lines = claudeLines("permissionDenied").map((line) => {
      const e = JSON.parse(line) as { type: string; permission_denials?: unknown[] };
      if (e.type !== "result") return line;
      // The spike saw errored calls listed here too: add the missing-file read.
      e.permission_denials = [
        ...(e.permission_denials ?? []),
        { tool_name: "Read", tool_use_id: "toolu_01KNGbZfb6tXhfN2nuWtMNZp", tool_input: { file_path: "/tmp/bsja-live/claude-deny/missing.txt" } },
      ];
      return JSON.stringify(e);
    });
    const { parser } = parse(lines);
    expect(parser.realDenials().map((d) => (d.input as { file_path: string }).file_path)).toEqual([
      expect.stringMatching(/secret\.txt$/),
    ]);
  });

  it("fails closed: a listed denial with no tool_result at all is real", () => {
    const lines = claudeLines("structuredOk").map((line) => {
      const e = JSON.parse(line) as { type: string; permission_denials?: unknown[] };
      if (e.type !== "result") return line;
      e.permission_denials = [{ tool_name: "mcp__claude-in-chrome__navigate", tool_use_id: "toolu_missing", tool_input: { url: "https://evil.example" } }];
      return JSON.stringify(e);
    });
    expect(parse(lines).parser.realDenials()).toEqual([
      { tool: "mcp__claude-in-chrome__navigate", input: { url: "https://evil.example" }, source: "permission", reason: null },
    ]);
  });

  it("invalid-output: still returns the structured output; validation is the runner's job", () => {
    const { parser } = parse(claudeLines("invalidOutput"));
    expect((parser.structuredOutput as { reply: string }).reply).toBe("");
    expect(parser.sessionId).toBe("a1767363-fdae-4ecc-8d91-c03467005daa");
  });

  it("repair-ok: the repair turn keeps the session id", () => {
    const { parser, events } = parse(claudeLines("repairOk"));
    expect(events[0]).toMatchObject({ type: "started", sessionId: "a1767363-fdae-4ecc-8d91-c03467005daa" });
    expect((parser.structuredOutput as { reply: string }).reply).toMatch(/PELICAN/);
  });

  it("resume-not-found: an error result with no output", () => {
    const { parser } = parse(claudeLines("resumeNotFound"));
    expect(parser.result).toMatchObject({ isError: true, subtype: "error_during_execution" });
    expect(parser.structuredOutput).toBeUndefined();
  });

  it("api-error: records the API error, emits its text as progress", () => {
    const { parser, events } = parse(claudeLines("apiError"));
    expect(parser.result).toMatchObject({ isError: true, apiErrorStatus: 404, terminalReason: "api_error" });
    expect(parser.apiError).toBe("model_not_found");
    expect(parser.errorText()).toMatch(/issue with the selected model/);
    expect(events.some((e) => e.type === "progress" && /selected model/.test(e.text))).toBe(true);
    expect(parser.limit).toBeNull();
  });

  it("usage-limit (synthetic): limited usage event and a limit signal with the reset time", () => {
    const { parser, events } = parse(claudeLines("usageLimit"));
    expect(events.filter((e) => e.type === "usage")).toEqual([
      { type: "usage", engine: "claude", usage: { fiveHour: 1, sevenDay: 0.41, resetsAt: "2026-10-10T20:40:00.000Z" }, limited: true },
    ]);
    expect(parser.limit).toEqual({ resetsAt: "2026-10-10T20:40:00.000Z", reason: "status" });
    expect(parser.result).toMatchObject({ isError: true, apiErrorStatus: 429 });
  });

  it("high-utilization (synthetic): limited usage on a successful run", () => {
    const { parser, events } = parse(claudeLines("highUtilization"));
    expect(events.find((e) => e.type === "usage")).toMatchObject({ limited: true });
    expect(parser.limit).toEqual({ resetsAt: "2026-10-10T20:40:00.000Z", reason: "utilization" });
    expect(parser.structuredOutput).toBeDefined();
  });

  it("a limit text in the result without a rate_limit_event is still a limit", () => {
    const { parser } = parse([
      JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached|1791664800", session_id: "s" }),
    ]);
    expect(parser.limit).toEqual({ resetsAt: null, reason: "error" });
  });

  it("chrome-init: lists the Claude in Chrome tools", () => {
    const { parser } = parse(claudeLines("chromeInit"));
    expect(parser.initTools).toContain("mcp__claude-in-chrome__navigate");
    expect(parser.initTools).toContain("mcp__claude-in-chrome__javascript_tool");
    expect(parse(claudeLines("chromeInitDisallowed")).parser.initTools).not.toContain("mcp__claude-in-chrome__javascript_tool");
  });

  it("ignores blank and non-JSON lines", () => {
    const parser = new ClaudeStreamParser({ pid: null });
    expect(parser.push("")).toEqual([]);
    expect(parser.push("not json")).toEqual([]);
    expect(parser.push('{"type":"something_new"}')).toEqual([]);
    expect(parser.result).toBeNull();
  });

  it("progress text is trimmed and tool summaries are short", () => {
    const parser = new ClaudeStreamParser({ pid: null });
    const long = "x".repeat(2000);
    const [progress] = parser.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: long }] } }));
    expect(progress).toMatchObject({ type: "progress" });
    expect((progress as { text: string }).text.length).toBeLessThanOrEqual(500);
    const [tool] = parser.push(
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__claude-in-chrome__navigate", input: { url: "https://topcv.vn/jobs" } }] } }),
    );
    expect(tool).toEqual({ type: "tool", name: "mcp__claude-in-chrome__navigate", status: "started", summary: "https://topcv.vn/jobs" });
  });
});
