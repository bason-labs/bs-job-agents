import { describe, expect, it } from "vitest";
import type { FigmaBridgeError } from "./errors.js";
import type { McpToolResult } from "./mcp.js";
import { parseExecuteReply, parseStatusReply } from "./replies.js";

const KEY = "kJFoXNrTfFOtkQ515c0jHk";
const now = new Date("2026-10-11T03:00:00.000Z");
const reply = (value: unknown, isError = false): McpToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});

/** Shape of figma-console-mcp 1.40.9's figma_get_status reply (dist/local.js). */
function status(opts: { probe?: boolean; files?: Array<{ fileKey: string; fileName: string; isActive?: boolean }>; currentKey?: string }) {
  const files = opts.files ?? [];
  return reply({
    mode: "local",
    currentFileName: files[0]?.fileName ?? "(unable to retrieve - Desktop Bridge may need to be opened)",
    currentFileKey: opts.currentKey ?? files[0]?.fileKey,
    transport: {
      active: files.length > 0 ? "websocket" : "none",
      websocket: {
        available: files.length > 0,
        serverRunning: true,
        port: "9224",
        connectedFiles: files.length > 0 ? files.map((f) => ({ ...f, currentPage: "resume", editorType: "figma" })) : undefined,
      },
    },
    setup: {
      valid: files.length > 0,
      failureLayer: files.length > 0 ? null : 2,
      probeResult: opts.probe === undefined ? undefined : { success: opts.probe, latencyMs: 12 },
      message: files.length > 0 ? "✅ Connected to Figma Desktop via WebSocket Bridge" : "❌ No connection to Figma Desktop",
    },
    initialized: files.length > 0,
  });
}

describe("parseStatusReply", () => {
  it("is connected when the probe succeeds and the CV file is among the connected files", () => {
    const s = parseStatusReply(status({ probe: true, files: [{ fileKey: KEY, fileName: "Resume (Community) V2", isActive: true }] }), KEY, now);
    expect(s).toMatchObject({
      state: "connected",
      connected: true,
      fileKey: KEY,
      fileName: "Resume (Community) V2",
      latencyMs: 12,
      checkedAt: "2026-10-11T03:00:00.000Z",
    });
    expect(s.connectedFiles).toEqual([{ fileKey: KEY, fileName: "Resume (Community) V2", active: true }]);
  });

  it("finds the CV file even when another file is active", () => {
    const s = parseStatusReply(
      status({
        probe: true,
        files: [
          { fileKey: "other", fileName: "Moodboard", isActive: true },
          { fileKey: KEY, fileName: "Resume (Community) V2", isActive: false },
        ],
      }),
      KEY,
      now,
    );
    expect(s).toMatchObject({ state: "connected", fileKey: KEY, fileName: "Resume (Community) V2" });
  });

  it("is wrong_file when only other files are connected", () => {
    const s = parseStatusReply(status({ probe: true, files: [{ fileKey: "other", fileName: "Moodboard", isActive: true }] }), KEY, now);
    expect(s).toMatchObject({ state: "wrong_file", connected: false });
    expect(s.message).toMatch(/Moodboard/);
  });

  it("is not connected when the plugin is closed or the probe fails", () => {
    expect(parseStatusReply(status({ probe: false }), KEY, now)).toMatchObject({ state: "not_connected", connected: false });
    expect(parseStatusReply(status({ probe: false, files: [{ fileKey: KEY, fileName: "R" }] }), KEY, now).state).toBe("not_connected");
    const s = parseStatusReply(status({ probe: false }), KEY, now);
    expect(s.message).toMatch(/Desktop Bridge/);
  });

  it("accepts any file when no CV file key is configured", () => {
    const s = parseStatusReply(status({ probe: true, files: [{ fileKey: "other", fileName: "Moodboard" }] }), null, now);
    expect(s).toMatchObject({ state: "connected", fileKey: "other" });
  });

  it("falls back to currentFileKey when connectedFiles is missing", () => {
    const r = reply({ currentFileName: "Resume", currentFileKey: KEY, setup: { valid: true, probeResult: { success: true, latencyMs: 3 } } });
    expect(parseStatusReply(r, KEY, now)).toMatchObject({ state: "connected", fileKey: KEY });
  });

  it("treats error replies and garbage as not connected", () => {
    expect(parseStatusReply(reply({ error: "boom", message: "Failed to retrieve status" }, true), KEY, now).state).toBe("not_connected");
    expect(parseStatusReply({ content: [{ type: "text", text: "nope" }] }, KEY, now).state).toBe("not_connected");
    expect(parseStatusReply({ content: [] }, KEY, now).state).toBe("not_connected");
  });
});

/** Shapes of figma_execute replies (dist/core/write-tools.js and the plugin's code.js). */
const ok = (result: unknown, fileKey: string | null = KEY) =>
  reply({ success: true, result, resultAnalysis: { type: typeof result }, fileContext: { fileName: "Resume", fileKey }, timestamp: 1 });
const pluginFail = (error: string) => reply({ success: false, error, timestamp: 1 });
const toolFail = (error: string) =>
  reply({ error, message: "Failed to execute code in Figma plugin context", hint: "Make sure the Desktop Bridge plugin is running in Figma" }, true);

function errorOf(r: McpToolResult, key: string | null = KEY): FigmaBridgeError {
  const out = parseExecuteReply(r, key);
  if (out.ok) throw new Error("expected an error");
  return out.error;
}

describe("parseExecuteReply", () => {
  it("returns the value and file of a successful call", () => {
    expect(parseExecuteReply(ok({ id: "1:2" }), KEY)).toEqual({ ok: true, value: { id: "1:2" }, fileKey: KEY, fileName: "Resume" });
    expect(parseExecuteReply(ok(null), KEY)).toMatchObject({ ok: true, value: null });
  });

  it("maps connection failures to not_connected", () => {
    expect(errorOf(toolFail("Cannot connect to Figma Desktop.\n\nOpen the Desktop Bridge plugin…")).code).toBe("not_connected");
    expect(errorOf(toolFail("No WebSocket client connected. Make sure the Desktop Bridge plugin is open in Figma.")).code).toBe("not_connected");
    expect(errorOf(toolFail("No active file connected. Make sure the Desktop Bridge plugin is open in Figma.")).code).toBe("not_connected");
  });

  it("maps time limits, syntax errors and thrown errors", () => {
    expect(errorOf(pluginFail("Error: Execution timed out after 5000ms")).code).toBe("timeout");
    expect(errorOf(toolFail("WebSocket command EXECUTE_CODE timed out after 7000ms")).code).toBe("timeout");
    expect(errorOf(pluginFail("Syntax error: Unexpected token")).code).toBe("syntax_error");
    const thrown = errorOf(pluginFail("TypeError: cannot read property 'x' of null"));
    expect(thrown.code).toBe("plugin_error");
    expect(thrown.message).toMatch(/cannot read property/);
  });

  it("maps the bridge snippets' BRIDGE:<CODE> errors", () => {
    expect(errorOf(pluginFail("Error: BRIDGE:NOT_FOUND:node 1:2 not found"))).toMatchObject({ code: "not_found", message: "node 1:2 not found" });
    expect(errorOf(pluginFail("Error: BRIDGE:FRAME_HIDDEN:frame X is hidden")).code).toBe("frame_hidden");
    expect(errorOf(pluginFail("Error: BRIDGE:NAME_TAKEN:X already exists")).code).toBe("name_taken");
    expect(errorOf(pluginFail("Error: BRIDGE:BOGUS:x")).code).toBe("plugin_error");
  });

  it("refuses a result that came from another file", () => {
    expect(errorOf(ok({ id: "1:2" }, "otherFileKey")).code).toBe("wrong_file");
    expect(parseExecuteReply(ok({ id: "1:2" }, "otherFileKey"), null).ok).toBe(true);
    expect(parseExecuteReply(ok({ id: "1:2" }, null), KEY).ok).toBe(true);
  });

  it("reports unreadable replies", () => {
    expect(errorOf({ content: [] }).code).toBe("bad_reply");
    expect(errorOf({ content: [{ type: "text", text: "{" }] }).code).toBe("bad_reply");
    expect(errorOf(reply({ hello: 1 })).code).toBe("bad_reply");
  });
});
