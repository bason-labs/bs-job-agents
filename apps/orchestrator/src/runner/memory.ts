// Bot memory (spec §5.4, rule 2): the orchestrator appends a task's memoryNotes to
// bots/<name>/memory.md one at a time, serialised per bot, and archives the oldest lines beyond
// LIMITS.memoryLinesMax to memory.archive.md. The engine records each note in memory_changes
// through `onNote` (the runner never touches the DB).
import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { LIMITS } from "@bs-job-agents/shared";

const NOTE_MAX = 300;
const locks = new Map<string, Promise<unknown>>();

/** Run `fn` after every earlier call for the same key has finished. */
function serialised<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  locks.set(key, next);
  void next.finally(() => {
    if (locks.get(key) === next) locks.delete(key);
  }).catch(() => undefined);
  return next;
}

const pad = (n: number) => String(n).padStart(2, "0");
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function formatMemoryLine(note: string, ctx: { runId: number | null; taskId: number | null; now: Date }): string {
  const where = [ctx.runId !== null ? `run ${ctx.runId}` : null, ctx.taskId !== null ? `task ${ctx.taskId}` : null].filter(Boolean);
  return `- ${[localDate(ctx.now), ...where].join(" · ")}: ${note}`;
}

const cleanNote = (note: string): string => note.replace(/\s+/g, " ").trim().slice(0, NOTE_MAX);
const noteOf = (line: string): string => line.replace(/^- [^:]*: /, "");

export interface AppendMemoryInput {
  /** bots/<name>/ */
  botDir: string;
  notes: readonly string[];
  runId: number | null;
  taskId: number | null;
  now?: Date;
  /** Called after each note is written, still inside the bot's lock (e.g. appendMemoryChange). */
  onNote?: (note: string) => void | Promise<void>;
}

export interface AppendMemoryResult {
  appended: string[];
  archived: number;
}

export function appendMemoryNotes(input: AppendMemoryInput): Promise<AppendMemoryResult> {
  const botDir = resolve(input.botDir);
  return serialised(botDir, async () => {
    const memoryPath = join(botDir, "memory.md");
    const archivePath = join(botDir, "memory.archive.md");
    const result: AppendMemoryResult = { appended: [], archived: 0 };
    for (const raw of input.notes) {
      const note = cleanNote(raw);
      if (!note) continue;
      const text = await readFile(memoryPath, "utf8").catch(() => "");
      const lines = text.split("\n").filter((l) => l.trim().length > 0);
      if (lines.some((l) => noteOf(l) === note)) continue;
      lines.push(formatMemoryLine(note, { runId: input.runId, taskId: input.taskId, now: input.now ?? new Date() }));
      if (lines.length > LIMITS.memoryLinesMax) {
        const overflow = lines.splice(0, lines.length - LIMITS.memoryLinesMax);
        await appendFile(archivePath, `${overflow.join("\n")}\n`);
        result.archived += overflow.length;
      }
      const tmp = `${memoryPath}.tmp`;
      await writeFile(tmp, `${lines.join("\n")}\n`);
      await rename(tmp, memoryPath);
      result.appended.push(note);
      await input.onNote?.(note);
    }
    return result;
  });
}
