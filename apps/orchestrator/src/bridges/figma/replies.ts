// Parsers for figma-console-mcp 1.40.9 replies (figma_get_status, figma_execute).
import { FigmaBridgeError, type FigmaBridgeErrorCode } from "./errors.js";
import type { McpToolResult } from "./mcp.js";

export type FigmaConnectionState = "connected" | "not_connected" | "wrong_file" | "server_unavailable";

export interface FigmaConnectedFile {
  fileKey: string;
  fileName: string | null;
  active: boolean;
}

export interface FigmaStatus {
  state: FigmaConnectionState;
  /** True only when CV tasks can use Figma now; otherwise they wait as `needs_figma`. */
  connected: boolean;
  /** The CV file when connected; otherwise the active file, if any. */
  fileKey: string | null;
  fileName: string | null;
  connectedFiles: FigmaConnectedFile[];
  latencyMs: number | null;
  /** What Ba should do, in one sentence. */
  message: string;
  checkedAt: string;
}

const OPEN_FIGMA =
  "Open Figma desktop with the CV file and run Plugins → Development → Figma Desktop Bridge.";

function textJson(result: McpToolResult): unknown {
  const text = result.content.find((c) => c.type === "text" && typeof c.text === "string")?.text;
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export function serverUnavailableStatus(message: string, now: Date): FigmaStatus {
  return {
    state: "server_unavailable",
    connected: false,
    fileKey: null,
    fileName: null,
    connectedFiles: [],
    latencyMs: null,
    message: `The local Figma bridge (figma-console-mcp) is not running: ${message}`,
    checkedAt: now.toISOString(),
  };
}

/** `figma_get_status {probe:true}`; `expectedFileKey` null accepts any file. */
export function parseStatusReply(result: McpToolResult, expectedFileKey: string | null, now: Date): FigmaStatus {
  const base = { connectedFiles: [] as FigmaConnectedFile[], latencyMs: null, checkedAt: now.toISOString() };
  const notConnected = (message: string): FigmaStatus => ({
    ...base,
    state: "not_connected",
    connected: false,
    fileKey: null,
    fileName: null,
    message,
  });

  const body = textJson(result);
  if (result.isError || !isObj(body)) return notConnected(`Figma is not reachable. ${OPEN_FIGMA}`);

  const setup = isObj(body.setup) ? body.setup : {};
  const probe = isObj(setup.probeResult) ? setup.probeResult : null;
  const latencyMs = probe && typeof probe.latencyMs === "number" ? probe.latencyMs : null;
  const alive = probe ? probe.success === true : setup.valid === true;

  const ws = isObj(body.transport) && isObj(body.transport.websocket) ? body.transport.websocket : {};
  let files: FigmaConnectedFile[] = Array.isArray(ws.connectedFiles)
    ? ws.connectedFiles.filter(isObj).flatMap((f) => {
        const key = str(f.fileKey);
        return key ? [{ fileKey: key, fileName: str(f.fileName), active: f.isActive === true }] : [];
      })
    : [];
  const currentKey = str(body.currentFileKey);
  if (files.length === 0 && currentKey) files = [{ fileKey: currentKey, fileName: str(body.currentFileName), active: true }];

  if (!alive) return { ...notConnected(`The Figma Desktop Bridge plugin is not responding. ${OPEN_FIGMA}`), connectedFiles: files };

  const target = expectedFileKey ? files.find((f) => f.fileKey === expectedFileKey) : (files.find((f) => f.active) ?? files[0]);
  if (!target && expectedFileKey) {
    const names = files.map((f) => `"${f.fileName ?? f.fileKey}"`).join(", ");
    return {
      ...base,
      state: "wrong_file",
      connected: false,
      fileKey: files.find((f) => f.active)?.fileKey ?? null,
      fileName: files.find((f) => f.active)?.fileName ?? null,
      connectedFiles: files,
      latencyMs,
      message: `Figma is connected to ${names || "a file without a key"}, not the CV file. Open the CV file and run the Desktop Bridge plugin in it.`,
    };
  }
  return {
    ...base,
    state: "connected",
    connected: true,
    fileKey: target?.fileKey ?? null,
    fileName: target?.fileName ?? null,
    connectedFiles: files,
    latencyMs,
    message: `Connected to Figma${target?.fileName ? ` file "${target.fileName}"` : ""}.`,
  };
}

export type ExecuteOutcome =
  | { ok: true; value: unknown; fileKey: string | null; fileName: string | null }
  | { ok: false; error: FigmaBridgeError };

const BRIDGE_CODES: Record<string, FigmaBridgeErrorCode> = {
  NOT_FOUND: "not_found",
  NOT_A_FRAME: "not_a_frame",
  NOT_IN_DRAFTS: "not_in_drafts",
  FRAME_HIDDEN: "frame_hidden",
  NAME_TAKEN: "name_taken",
  NO_DRAFTS_PAGE: "no_drafts_page",
};

function classify(message: string, fromTool: boolean): FigmaBridgeError {
  if (/Cannot connect to Figma Desktop|No (active file|WebSocket client) connected/i.test(message)) {
    return new FigmaBridgeError("not_connected", `Figma is not reachable: ${message.split("\n")[0]}`);
  }
  if (/timed out/i.test(message)) return new FigmaBridgeError("timeout", message);
  if (/^Syntax error/i.test(message)) return new FigmaBridgeError("syntax_error", message);
  const bridge = /BRIDGE:([A-Z_]+):([\s\S]*)$/.exec(message);
  if (bridge) {
    const code = BRIDGE_CODES[bridge[1] ?? ""];
    if (code) return new FigmaBridgeError(code, (bridge[2] ?? "").trim());
  }
  return new FigmaBridgeError("plugin_error", fromTool ? `figma_execute failed: ${message}` : message);
}

/** `figma_execute`; a result from another file than `expectedFileKey` is refused. */
export function parseExecuteReply(result: McpToolResult, expectedFileKey: string | null): ExecuteOutcome {
  const body = textJson(result);
  if (!isObj(body)) return { ok: false, error: new FigmaBridgeError("bad_reply", "figma_execute returned no readable reply") };
  if (result.isError) return { ok: false, error: classify(str(body.error) ?? str(body.message) ?? "unknown error", true) };
  if (body.success === false) return { ok: false, error: classify(str(body.error) ?? "unknown error", false) };
  if (body.success !== true) return { ok: false, error: new FigmaBridgeError("bad_reply", "figma_execute reply has no success flag") };

  const ctx = isObj(body.fileContext) ? body.fileContext : {};
  const fileKey = str(ctx.fileKey);
  if (expectedFileKey && fileKey && fileKey !== expectedFileKey) {
    return {
      ok: false,
      error: new FigmaBridgeError("wrong_file", `the call ran in file ${fileKey}, not the CV file ${expectedFileKey}`),
    };
  }
  return { ok: true, value: body.result ?? null, fileKey, fileName: str(ctx.fileName) };
}
