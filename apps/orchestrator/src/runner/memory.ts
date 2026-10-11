// Bot memory (spec §5.4, rule 2): the orchestrator appends a task's memoryNotes to
// bots/<name>/memory.md one at a time, serialised per bot, and archives the oldest lines beyond
// LIMITS.memoryLinesMax to memory.archive.md. The engine records each note in memory_changes
// through `onNote` (the runner never touches the DB).
// PM2 S5: memory.md and memory.archive.md are runtime state, gitignored like data/ (Ba's lessons
// never end up in commits). Start-up seeds a missing memory.md from MEMORY_TEMPLATE; the first
// append creates it too.
import { existsSync } from "node:fs";
import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { LIMITS } from "@bs-job-agents/shared";
import { filterMemoryNotes, type FilteredMemoryNotes } from "./memory-hygiene.js";

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

const noteOf = (line: string): string => line.replace(/^- [^:]*: /, "");

export interface AppendMemoryInput {
  /** bots/<name>/ */
  botDir: string;
  notes: readonly string[];
  runId: number | null;
  taskId: number | null;
  now?: Date;
  /**
   * PM2 S14: hosts a note may name (the bot's allowlist; Apply: the task's approved domains).
   * Omitted = none. Notes with a secret, an override or another host are dropped (memory-hygiene.ts).
   */
  allowedSites?: readonly string[];
  /** Called after each note is written, still inside the bot's lock (e.g. appendMemoryChange). */
  onNote?: (note: string) => void | Promise<void>;
}

export interface AppendMemoryResult {
  appended: string[];
  archived: number;
  /** PM2 S14: notes that were not written, and why. */
  dropped: FilteredMemoryNotes["dropped"];
}

export function appendMemoryNotes(input: AppendMemoryInput): Promise<AppendMemoryResult> {
  const botDir = resolve(input.botDir);
  const screened = filterMemoryNotes(input.notes, { allowedSites: input.allowedSites ?? [] });
  return serialised(botDir, async () => {
    const memoryPath = join(botDir, "memory.md");
    const archivePath = join(botDir, "memory.archive.md");
    const result: AppendMemoryResult = { appended: [], archived: 0, dropped: screened.dropped };
    for (const note of screened.kept) {
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

/** What a new bots/<name>/memory.md holds: nothing yet (the prompt then says "no notes yet"). */
export const MEMORY_TEMPLATE = "";

/**
 * Create bots/<name>/memory.md from MEMORY_TEMPLATE for each bot whose folder exists and has no
 * memory file yet (PM2 S5). Never overwrites: an existing file keeps Ba's notes. Returns the files
 * it created.
 */
export async function seedMemoryFiles(botsDir: string, botNames: readonly string[]): Promise<string[]> {
  const created: string[] = [];
  for (const name of botNames) {
    const botDir = join(resolve(botsDir), name);
    if (!existsSync(botDir)) continue;
    const path = join(botDir, "memory.md");
    await serialised(botDir, async () => {
      try {
        await writeFile(path, MEMORY_TEMPLATE, { flag: "wx" });
        created.push(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    });
  }
  return created;
}
