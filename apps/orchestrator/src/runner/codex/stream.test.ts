import { describe, expect, it } from "vitest";
import { codexLastMessage, codexLines } from "../__fixtures__/index.js";
import type { RunnerEvent } from "../types.js";
import { CodexStreamParser } from "./stream.js";

const NOW = new Date(2026, 9, 11, 9, 0, 0);

function parse(lines: readonly string[]) {
  const parser = new CodexStreamParser({ pid: 777, now: () => NOW });
  const events: RunnerEvent[] = [];
  for (const line of lines) events.push(...parser.push(line));
  return { parser, events };
}

const tools = (events: RunnerEvent[]) =>
  events
    .filter((e): e is Extract<RunnerEvent, { type: "tool" }> => e.type === "tool")
    .map((e) => `${e.name}:${e.status}:${e.summary ?? ""}`);

describe("CodexStreamParser on real exec --json captures", () => {
  it("structured-ok: started with the thread id; ignores the skip_host_skill_discovery warning", () => {
    const { parser, events } = parse(codexLines("structuredOk"));
    expect(events).toEqual([{ type: "started", engine: "codex", sessionId: "01a126da-c068-79b0-93c3-7cf34d4305ec", pid: 777 }]);
    expect(parser.threadId).toBe("01a126da-c068-79b0-93c3-7cf34d4305ec");
    expect(parser.lastMessage).toBe(codexLastMessage(codexLines("structuredOk")));
    expect(parser.turnCompleted).toBe(true);
    expect(parser.failure).toBeNull();
    expect(parser.limit).toBeNull();
    expect(parser.tokenUsage).toMatchObject({ input_tokens: 19619, output_tokens: 56 });
  });

  it("mcp-tools: mcp_tool_call items become tool events named like Claude's", () => {
    const { events } = parse(codexLines("mcpTools"));
    expect(tools(events)).toEqual([
      'mcp__echo__echo:started:hi',
      'mcp__echo__echo:done:hi',
      'mcp__echo__wipe:started:/tmp/x',
      'mcp__echo__wipe:done:/tmp/x',
    ]);
  });

  it("mcp-allowlist: interim agent messages are progress; the final JSON message is not", () => {
    const { events, parser } = parse(codexLines("mcpAllowlist"));
    expect(events.filter((e) => e.type === "progress")).toEqual([
      { type: "progress", text: "I’ll check the available MCP tools, then attempt both calls once." },
    ]);
    expect(tools(events)).toEqual(["mcp__echo__echo:started:hi", "mcp__echo__echo:done:hi"]);
    expect(JSON.parse(parser.lastMessage!)).toMatchObject({ reply: expect.stringContaining("not in the available MCP tool list") });
  });

  it("shell: command_execution items", () => {
    const { events } = parse(codexLines("shell"));
    expect(tools(events)).toEqual(["shell:started:/bin/zsh -lc pwd", "shell:done:/bin/zsh -lc pwd"]);
  });

  it("a failed command or MCP call is an error event", () => {
    const parser = new CodexStreamParser({ pid: null, now: () => NOW });
    const [cmd] = parser.push(
      JSON.stringify({ type: "item.completed", item: { id: "i1", type: "command_execution", command: "touch x", aggregated_output: "", exit_code: 1, status: "failed" } }),
    );
    expect(cmd).toEqual({ type: "tool", name: "shell", status: "error", summary: "touch x" });
    const [mcp] = parser.push(
      JSON.stringify({ type: "item.completed", item: { id: "i2", type: "mcp_tool_call", server: "figma", tool: "figma_execute", arguments: {}, result: null, error: { message: "boom" }, status: "failed" } }),
    );
    expect(mcp).toEqual({ type: "tool", name: "mcp__figma__figma_execute", status: "error", summary: "boom" });
  });

  it("web-search: the completed item carries the query", () => {
    const { events } = parse(codexLines("webSearch"));
    expect(tools(events)).toEqual(["web_search:started:", "web_search:done:IANA example domains"]);
  });

  it("apps-connector-search: the built-in codex_apps server shows up as an MCP tool (why non-browser bots get --disable apps)", () => {
    const { events } = parse(codexLines("appsConnectorSearch"));
    expect(tools(events)[0]).toMatch(/^mcp__codex_apps__search_service\.web_run:started:/);
  });

  it("invalid-output and repair-ok: same thread id, last message per turn", () => {
    const a = parse(codexLines("invalidOutput"));
    const b = parse(codexLines("repairOk"));
    expect(a.parser.threadId).toBe(b.parser.threadId);
    expect(JSON.parse(a.parser.lastMessage!).reply).toBe("");
    expect(JSON.parse(b.parser.lastMessage!).reply).toMatch(/PELICAN/);
  });

  it("turn-failed: keeps the failure message; not a usage limit", () => {
    const { parser, events } = parse(codexLines("turnFailed"));
    expect(parser.turnCompleted).toBe(false);
    expect(parser.failure).toMatch(/invalid_json_schema/);
    expect(parser.limit).toBeNull();
    expect(events.some((e) => e.type === "progress" && /invalid_json_schema/.test(e.text))).toBe(true);
  });

  it("usage-limit (synthetic): limited with the next 3:45 PM; emits a limited usage event", () => {
    const { parser, events } = parse(codexLines("usageLimit"));
    const resetsAt = new Date(2026, 9, 11, 15, 45).toISOString();
    expect(parser.limit).toEqual({ limited: true, resetsAt });
    expect(events.filter((e) => e.type === "usage")).toEqual([
      { type: "usage", engine: "codex", usage: { fiveHour: null, sevenDay: null, resetsAt }, limited: true },
    ]);
  });

  it("usage-limit-json (synthetic): resets_at from the API body", () => {
    const { parser } = parse(codexLines("usageLimitJson"));
    expect(parser.limit).toEqual({ limited: true, resetsAt: new Date(1791670000 * 1000).toISOString() });
  });

  it("ignores non-JSON lines such as the stdin notice", () => {
    const parser = new CodexStreamParser({ pid: null, now: () => NOW });
    expect(parser.push("Reading additional input from stdin...")).toEqual([]);
    expect(parser.push("")).toEqual([]);
  });
});
