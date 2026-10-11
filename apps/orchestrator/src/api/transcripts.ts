// UC-22 step drawer: a task attempt's transcript (data/transcripts/<taskId>-<attempt>.jsonl, §5.5
// step 3), made safe to show. The raw file holds CLI stream-json lines and the runner's notes; the
// API never sends it as is:
// - each line is summarised to { n, kind, text } (assistant text, a tool call with its input, a
//   tool result, the session start, the result, a runner note);
// - texts are redacted: image data and long base64 runs, 64-hex values (approval tokens, hashes),
//   the per-spawn MCP capability in a URL, and every stored approval token;
// - texts are cut at TEXT_MAX, at most LINES_MAX lines are returned (the newest), and a file over
//   FILE_MAX is read from its tail only.
// Poll with `after` (the last `nextAfter`) while the task runs.
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { TranscriptLine } from "@bs-job-agents/shared";

export const TEXT_MAX = 2_000;
export const LINES_MAX = 500;
/** Bytes read from one transcript (its tail when it is larger). */
export const FILE_MAX = 8 * 1024 * 1024;

const clip = (text: string): string => (text.length <= TEXT_MAX ? text : `${text.slice(0, TEXT_MAX - 1)}…`);

/** Redact what must never reach the UI. `tokens` are the stored approval tokens (any format). */
export function redact(text: string, tokens: readonly string[] = []): string {
  let out = text;
  for (const token of tokens) if (token.length >= 16) out = out.split(token).join("[redacted]");
  return out
    .replace(/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, "[image]")
    .replace(/\/mcp\/[^\s"'/?#]+/g, "/mcp/[redacted]")
    .replace(/\b[a-f0-9]{64}\b/gi, "[redacted]")
    .replace(/[A-Za-z0-9+/=_-]{200,}/g, "[binary]");
}

const short = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
};

type Entry = { kind: TranscriptLine["kind"]; text: string };

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return short(content);
  return content
    .map((c: unknown) => {
      const item = c as { type?: unknown; text?: unknown };
      if (item.type === "text" && typeof item.text === "string") return item.text;
      if (item.type === "image") return "[image]";
      return short(c);
    })
    .join("\n");
}

/** One transcript line → zero or more display entries. */
export function summarizeLine(raw: string): Entry[] {
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return [{ kind: "other", text: raw }];
  }
  if (!rec || typeof rec !== "object") return [{ kind: "other", text: raw }];
  const type = typeof rec.type === "string" ? rec.type : "";
  if (type.startsWith("runner.")) {
    const { type: _t, ...rest } = rec;
    return [{ kind: "runner", text: `${type} ${short(rest)}` }];
  }
  if (type === "system") {
    if (rec.subtype !== "init") return [];
    const tools = Array.isArray(rec.tools) ? rec.tools.length : 0;
    return [{ kind: "system", text: `session started (model ${short(rec.model)}, ${tools} tools)` }];
  }
  if (type === "assistant" || type === "user") {
    const content = (rec.message as { content?: unknown } | undefined)?.content;
    const items = Array.isArray(content) ? content : [content];
    const out: Entry[] = [];
    for (const c of items) {
      const item = (c ?? {}) as { type?: unknown; text?: unknown; name?: unknown; input?: unknown; content?: unknown };
      if (item.type === "text" && typeof item.text === "string") out.push({ kind: "text", text: item.text });
      else if (item.type === "tool_use") out.push({ kind: "tool", text: `${short(item.name)} ${short(item.input)}` });
      else if (item.type === "tool_result") out.push({ kind: "tool_result", text: contentText(item.content) });
      else if (item.type === "thinking") continue;
      else if (typeof c === "string") out.push({ kind: type === "assistant" ? "text" : "other", text: c });
    }
    return out;
  }
  if (type === "result") {
    return [{ kind: "result", text: `result: ${short(rec.subtype)}${typeof rec.duration_ms === "number" ? ` in ${Math.round(rec.duration_ms / 1000)} s` : ""}` }];
  }
  // Codex exec --json: item events.
  if (type.startsWith("item.")) {
    const item = (rec.item ?? {}) as { type?: unknown; text?: unknown; command?: unknown; aggregated_output?: unknown; tool?: unknown; server?: unknown; arguments?: unknown };
    if (type !== "item.completed") return [];
    if (item.type === "agent_message" && typeof item.text === "string") return [{ kind: "text", text: item.text }];
    if (item.type === "command_execution") return [{ kind: "tool", text: `shell ${short(item.command)}` }, { kind: "tool_result", text: short(item.aggregated_output ?? "") }];
    if (item.type === "mcp_tool_call") return [{ kind: "tool", text: `${short(item.server)}.${short(item.tool)} ${short(item.arguments)}` }];
    return [{ kind: "other", text: short(item.type) }];
  }
  return [];
}

/** Transcript attempts that exist for a task, oldest first. */
export function transcriptAttempts(dataDir: string, taskId: number, maxAttempt: number): number[] {
  const out: number[] = [];
  // Attempts beyond the row's count can exist briefly (a retry starting); look a little further.
  for (let a = 1; a <= Math.max(5, maxAttempt); a++) if (existsSync(join(dataDir, "transcripts", `${taskId}-${a}.jsonl`))) out.push(a);
  return out;
}

export interface TranscriptRead {
  lines: TranscriptLine[];
  nextAfter: number;
  truncated: boolean;
}

/** Read one attempt's transcript after line `after`, summarised, redacted and capped. */
export function readTranscript(path: string, opts: { after: number; tokens?: readonly string[] }): TranscriptRead {
  const fd = openSync(path, "r");
  let text: string;
  let skippedHead = false;
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - FILE_MAX);
    skippedHead = start > 0;
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    text = buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
  let raw = text.split("\n");
  if (raw.at(-1) === "") raw = raw.slice(0, -1);
  // From the tail, the first line is partial and the line numbers are unknown: number them from 1
  // after the skipped part and say the head was left out.
  if (skippedHead) raw = raw.slice(1);
  const lines: TranscriptLine[] = [];
  let truncated = skippedHead;
  for (let i = opts.after; i < raw.length; i++) {
    for (const e of summarizeLine(raw[i]!)) {
      const t = redact(e.text, opts.tokens ?? []).trim();
      if (t === "") continue;
      lines.push({ n: i + 1, kind: e.kind, text: clip(t) });
    }
  }
  if (lines.length > LINES_MAX) {
    truncated = true;
    lines.splice(0, lines.length - LINES_MAX);
  }
  return { lines, nextAfter: Math.max(opts.after, raw.length), truncated };
}
