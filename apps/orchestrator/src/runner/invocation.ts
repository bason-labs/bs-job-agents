// One CLI invocation: the command line plus the files to write before spawning it.

export interface Invocation {
  command: string;
  args: string[];
  /** Absolute path → content, written into the task's work dir before spawning. */
  files: Record<string, string>;
  /** args with the prompt and schema shortened: what the transcript and logs show. */
  display: string[];
}

/** Replace the value after each flag in `flags` (and optionally the last arg) with a short label. */
export function displayArgs(
  args: readonly string[],
  labels: Record<string, (value: string) => string>,
  last?: (value: string) => string,
): string[] {
  const out = [...args];
  for (let i = 0; i < out.length - 1; i += 1) {
    const label = labels[out[i]!];
    if (label) {
      out[i + 1] = label(out[i + 1]!);
      i += 1;
    }
  }
  if (last && out.length > 0) out[out.length - 1] = last(out[out.length - 1]!);
  return out;
}

export const promptLabel = (value: string): string => `<prompt: ${value.length} chars>`;

export const schemaLabel = (value: string): string => {
  try {
    const title = (JSON.parse(value) as { title?: unknown }).title;
    return `<schema: ${typeof title === "string" ? title : "?"}>`;
  } catch {
    return "<schema>";
  }
};
