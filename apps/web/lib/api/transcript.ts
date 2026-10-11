// UC-22 step drawer transcript. Two sources with two shapes, shown as one list:
// - saved lines: GET /tasks/:id/transcript (the shared TranscriptResponse, summarised by the
//   orchestrator from its transcript file: `{ n, kind: text|tool|tool_result|system|result|runner|other, text }`);
// - live lines: `task.progress` events while the task runs (`{ at, kind: text|tool_use|tool_result|status, text, tool }`).
import type { TranscriptLine } from "@bs-job-agents/shared";
import type { ProgressLine } from "./contract";

export interface TranscriptViewLine {
  kind: "text" | "tool" | "result" | "status";
  text: string;
}

export function fromSaved(line: TranscriptLine): TranscriptViewLine {
  switch (line.kind) {
    case "text":
      return { kind: "text", text: line.text };
    case "tool":
      return { kind: "tool", text: line.text };
    case "tool_result":
      return { kind: "result", text: line.text };
    default:
      return { kind: "status", text: line.text };
  }
}

const withTool = (tool: string | null, text: string) => (tool ? `${tool} — ${text}` : text);

export function fromProgress(line: ProgressLine): TranscriptViewLine {
  switch (line.kind) {
    case "tool_use":
      return { kind: "tool", text: withTool(line.tool, line.text) };
    case "tool_result":
      return { kind: "result", text: withTool(line.tool, line.text) };
    case "status":
      return { kind: "status", text: line.text };
    default:
      return { kind: "text", text: line.text };
  }
}

/** What the orchestrator's transcript route makes of these progress lines (the mock backend's GET). */
export function toSavedLines(lines: readonly ProgressLine[]): TranscriptLine[] {
  const kind = { text: "text", tool_use: "tool", tool_result: "tool_result", status: "system" } as const;
  return lines.map((l, i) => ({ n: i + 1, kind: kind[l.kind], text: withTool(l.kind === "tool_use" || l.kind === "tool_result" ? l.tool : null, l.text) }));
}

/** Saved lines, then the live lines not already saved (a line can arrive both ways while the drawer loads). */
export function mergeTranscript(saved: readonly TranscriptLine[], live: readonly ProgressLine[]): TranscriptViewLine[] {
  const out = saved.map(fromSaved);
  const seen = new Set(out.map((l) => `${l.kind}|${l.text}`));
  for (const l of live.map(fromProgress)) if (!seen.has(`${l.kind}|${l.text}`)) out.push(l);
  return out;
}
