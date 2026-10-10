// Small text helpers for progress and tool events.

/** Collapse whitespace and cut to `max` characters (with an ellipsis). */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`;
}

const SUMMARY_KEYS = ["url", "file_path", "path", "query", "command", "text", "code"] as const;

/** One short line describing a tool call's input, e.g. the URL for navigate or the path for Read. */
export function summarizeToolInput(input: unknown, max = 160): string | null {
  if (typeof input === "string") return clip(input, max) || null;
  if (typeof input !== "object" || input === null) return null;
  const o = input as Record<string, unknown>;
  for (const key of SUMMARY_KEYS) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) return clip(v, max);
  }
  const json = JSON.stringify(input);
  return json === "{}" || json === "[]" ? null : clip(json, max);
}
