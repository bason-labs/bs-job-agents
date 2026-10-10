// data/master-cv.yaml (§6.1, UC-20): Ba's master facts. Bots only read a per-task copy; the API
// reads and writes it for the Master CV screen. The engine reads the same file (its top-level
// `version:` line) to pin a run's master version and to refuse a run when it is missing (UC-01 c).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MASTER_CV_FILE = "master-cv.yaml";

export const masterCvPath = (dataDir: string): string => join(dataDir, MASTER_CV_FILE);

/** The current master version: null when the file is missing; its `version:` line, else 1 (the engine's rule). */
export function readMasterCvVersion(dataDir: string): number | null {
  const path = masterCvPath(dataDir);
  if (!existsSync(path)) return null;
  const m = /^version:\s*(\d+)\s*$/m.exec(readFileSync(path, "utf8"));
  return m ? Number(m[1]) : 1;
}
