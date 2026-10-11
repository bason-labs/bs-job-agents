// data/master-cv.yaml (§6.1, UC-20): Ba's master facts. Bots only read a per-task copy; the API
// reads and writes it for the Master CV screen. The engine reads the same file (its top-level
// `version:` line) to pin a run's master version and to refuse a run when it is missing (UC-01 c).
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MasterCvSchema, type MasterCv } from "@bs-job-agents/shared";
import { parse, stringify } from "yaml";
import { zodMessage } from "./errors.js";

export const MASTER_CV_FILE = "master-cv.yaml";
/** UC-20 history: data/master-cv-history/v<version>.yaml, one per save. */
export const MASTER_CV_HISTORY_DIR = "master-cv-history";

/** Keep a copy of a saved version for the history list. */
export async function keepMasterCvVersion(dataDir: string, cv: MasterCv): Promise<void> {
  const dir = join(dataDir, MASTER_CV_HISTORY_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `v${cv.version}.yaml`), HEADER + stringify(cv, { lineWidth: 0 }), { mode: 0o600 });
}

/** Saved versions, newest first, with the current file's version even if it was saved by hand. */
export function listMasterCvVersions(dataDir: string): { version: number; savedAt: string; factCount: number }[] {
  const out = new Map<number, { version: number; savedAt: string; factCount: number }>();
  const add = (path: string) => {
    try {
      const parsed = MasterCvSchema.safeParse(parse(readFileSync(path, "utf8")));
      if (parsed.success && !out.has(parsed.data.version)) {
        out.set(parsed.data.version, { version: parsed.data.version, savedAt: statSync(path).mtime.toISOString(), factCount: parsed.data.facts.length });
      }
    } catch {
      // An unreadable copy is left out of the list.
    }
  };
  if (existsSync(masterCvPath(dataDir))) add(masterCvPath(dataDir));
  const dir = join(dataDir, MASTER_CV_HISTORY_DIR);
  if (existsSync(dir)) for (const f of readdirSync(dir)) if (/^v\d+\.yaml$/.test(f)) add(join(dir, f));
  return [...out.values()].sort((a, b) => b.version - a.version);
}

export const masterCvPath = (dataDir: string): string => join(dataDir, MASTER_CV_FILE);

/** The current master version: null when the file is missing; its `version:` line, else 1 (the engine's rule). */
export function readMasterCvVersion(dataDir: string): number | null {
  const path = masterCvPath(dataDir);
  if (!existsSync(path)) return null;
  const m = /^version:\s*(\d+)\s*$/m.exec(readFileSync(path, "utf8"));
  return m ? Number(m[1]) : 1;
}

export type MasterCvRead = { kind: "missing" } | { kind: "ok"; cv: MasterCv } | { kind: "invalid"; detail: string };

/** Parse the file (Ba may edit it by hand too). */
export function readMasterCv(dataDir: string): MasterCvRead {
  const path = masterCvPath(dataDir);
  if (!existsSync(path)) return { kind: "missing" };
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { kind: "invalid", detail: `not valid YAML: ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = MasterCvSchema.safeParse(raw);
  return parsed.success ? { kind: "ok", cv: parsed.data } : { kind: "invalid", detail: zodMessage(parsed.error) };
}

const HEADER = "# Ba's master CV facts (spec §6.1). Edited on the Master CV screen; bots only read it.\n";

/**
 * The same atomic write and history copy, synchronously: the fact-draft sink runs inside the engine's
 * settle transaction (owner request 2026-10-11), where nothing may await.
 */
export function writeMasterCvSync(dataDir: string, cv: MasterCv): void {
  const path = masterCvPath(dataDir);
  const tmp = join(dataDir, `.master-cv.${randomBytes(6).toString("hex")}.yaml`);
  try {
    writeFileSync(tmp, HEADER + stringify(cv, { lineWidth: 0 }), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function keepMasterCvVersionSync(dataDir: string, cv: MasterCv): void {
  const dir = join(dataDir, MASTER_CV_HISTORY_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `v${cv.version}.yaml`), HEADER + stringify(cv, { lineWidth: 0 }), { mode: 0o600 });
}

/** A saved version from the history folder, or null when it is missing or unreadable. */
export function readMasterCvHistory(dataDir: string, version: number): MasterCv | null {
  const path = join(dataDir, MASTER_CV_HISTORY_DIR, `v${version}.yaml`);
  if (!existsSync(path)) return null;
  try {
    const parsed = MasterCvSchema.safeParse(parse(readFileSync(path, "utf8")));
    return parsed.success && parsed.data.version === version ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Write atomically (temp file + rename), so a bot's copy or the engine never reads half a file. */
export async function writeMasterCv(dataDir: string, cv: MasterCv): Promise<void> {
  const path = masterCvPath(dataDir);
  const tmp = join(dataDir, `.master-cv.${randomBytes(6).toString("hex")}.yaml`);
  try {
    await writeFile(tmp, HEADER + stringify(cv, { lineWidth: 0 }), { mode: 0o600 });
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
