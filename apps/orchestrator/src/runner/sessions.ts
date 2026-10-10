// Removing the CLI sessions the runner persisted only so the repair prompt could resume them.
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionId(id: string): boolean {
  return SESSION_ID.test(id);
}

/**
 * Claude keeps a session at <configDir>/projects/<cwd as a slug>/<id>.jsonl (plus <id>/ for large
 * tool results). Ids are random UUIDs, so removing that name in every project folder is safe.
 */
export async function removeClaudeSession(configDir: string, sessionId: string): Promise<void> {
  if (!isSessionId(sessionId)) return;
  const projects = join(configDir, "projects");
  let dirs: string[];
  try {
    dirs = await readdir(projects);
  } catch {
    return;
  }
  await Promise.all(
    dirs.flatMap((d) => [
      rm(join(projects, d, `${sessionId}.jsonl`), { force: true }),
      rm(join(projects, d, sessionId), { recursive: true, force: true }),
    ]),
  );
}
