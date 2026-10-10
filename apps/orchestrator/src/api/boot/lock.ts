// One orchestrator per data folder (W2a brief: locks and caps live in memory; two engines on one
// database would each think they own the running tasks, and start-up recovery would mark the other
// one's tasks interrupted). data/orchestrator.lock holds the owner's pid. A lock whose process is
// gone is stale and taken over; a live owner (e.g. `tsx watch` still shutting the old process down)
// is waited for, then refused.
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const LOCK_FILE = "orchestrator.lock";

export class DataFolderLockedError extends Error {
  constructor(
    readonly dataDir: string,
    readonly pid: number,
  ) {
    super(
      `another orchestrator (pid ${pid}) is using ${dataDir}; stop it first (or delete ${join(dataDir, LOCK_FILE)} if that process is not an orchestrator)`,
    );
    this.name = "DataFolderLockedError";
  }
}

function isOrchestratorAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
  try {
    // pids are reused: only a node process (node, tsx) can be an orchestrator.
    return /node|tsx/.test(execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }));
  } catch {
    return true;
  }
}

function tryCreate(path: string): boolean {
  try {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeSync(fd, String(process.pid));
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

function ownerOf(path: string): number {
  try {
    return Number(readFileSync(path, "utf8").trim());
  } catch {
    return 0;
  }
}

export interface DataFolderLock {
  release(): void;
}

/** Take data/orchestrator.lock, waiting up to `waitMs` for a live owner to exit. */
export async function lockDataFolder(dataDir: string, opts: { waitMs?: number; pollMs?: number } = {}): Promise<DataFolderLock> {
  const path = join(dataDir, LOCK_FILE);
  const deadline = Date.now() + (opts.waitMs ?? 15_000);
  for (;;) {
    if (tryCreate(path)) break;
    const pid = ownerOf(path);
    if (!isOrchestratorAlive(pid)) {
      try {
        unlinkSync(path);
      } catch {
        // Someone else took it over in between; try again.
      }
      continue;
    }
    if (Date.now() >= deadline) throw new DataFolderLockedError(dataDir, pid);
    await sleep(opts.pollMs ?? 250);
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      if (ownerOf(path) === process.pid) {
        try {
          unlinkSync(path);
        } catch {
          // Already gone.
        }
      }
    },
  };
}
