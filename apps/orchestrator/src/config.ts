// Orchestrator settings: port, folders and the web app's origins (spec §4, §4.3; PM S12, S18, S19).
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Default orchestrator port (the spec §4 diagram). Not 4318: that is the OpenTelemetry
 * OTLP/HTTP port, which a local collector may already hold (PM phase 1, S12).
 */
export const DEFAULT_PORT = 4100;
/** S18: the API listens on the loopback interface only; nothing in the environment changes it. */
export const DEFAULT_HOST = "127.0.0.1";
/** The Next.js web app (`pnpm dev:web`, port 3000), by either loopback name. */
export const DEFAULT_WEB_ORIGINS: readonly string[] = ["http://localhost:3000", "http://127.0.0.1:3000"];

/** Port from `ORCH_PORT`, defaulting to 4100. */
export function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ORCH_PORT;
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ORCH_PORT: ${raw}`);
  }
  return port;
}

/** The repo root: the folder above this file that holds pnpm-workspace.yaml (works from src/ and dist/). */
export function findRepoRoot(from: string = dirname(fileURLToPath(import.meta.url))): string {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no pnpm-workspace.yaml above ${from}`);
    dir = parent;
  }
}

export interface OrchestratorConfig {
  /** Always 127.0.0.1 (S18). */
  host: typeof DEFAULT_HOST;
  port: number;
  repoRoot: string;
  /** data/ (§4.3): app.db, CV PDFs, uploads, exports, transcripts, master-cv.yaml. `ORCH_DATA_DIR`. */
  dataDir: string;
  /** bots/<name>/ definitions. `ORCH_BOTS_DIR`. */
  botsDir: string;
  /** workflows/*.yaml (§7). `ORCH_WORKFLOWS_DIR`. */
  workflowsDir: string;
  /** Origins the API accepts requests from (the web app). `ORCH_WEB_ORIGINS`, comma-separated. */
  webOrigins: readonly string[];
}

function folder(env: NodeJS.ProcessEnv, key: string, repoRoot: string, fallback: string): string {
  const raw = env[key]?.trim();
  if (!raw) return join(repoRoot, fallback);
  return isAbsolute(raw) ? resolve(raw) : resolve(repoRoot, raw);
}

/** A bare http(s) origin such as http://localhost:3000 (no path, query or wildcard). */
function parseOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`ORCH_WEB_ORIGINS: ${raw} is not an origin such as http://localhost:3000`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== raw.replace(/\/$/, "")) {
    throw new Error(`ORCH_WEB_ORIGINS: ${raw} is not an origin such as http://localhost:3000`);
  }
  return url.origin;
}

/**
 * Settings from the environment. Relative folder overrides resolve against the repo root, because
 * `pnpm dev:orchestrator` runs in apps/orchestrator while data/ lives at the root (§4.3).
 */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env, repoRoot: string = findRepoRoot()): OrchestratorConfig {
  const origins = env.ORCH_WEB_ORIGINS?.trim();
  return {
    host: DEFAULT_HOST,
    port: resolvePort(env),
    repoRoot,
    dataDir: folder(env, "ORCH_DATA_DIR", repoRoot, "data"),
    botsDir: folder(env, "ORCH_BOTS_DIR", repoRoot, "bots"),
    workflowsDir: folder(env, "ORCH_WORKFLOWS_DIR", repoRoot, "workflows"),
    webOrigins: origins ? origins.split(",").map((o) => parseOrigin(o.trim())) : DEFAULT_WEB_ORIGINS,
  };
}

export type DataDirCheck = { ok: true } | { ok: false; detail: string };

/**
 * S19 / the runner's read-dir rule: a bot reads its task folder under data/ through Claude's
 * `--add-dir <dir>` and `Read(//<dir>/**)`, which a space, comma or parenthesis breaks. So the data
 * folder must not contain one (e.g. not ~/Library/Application Support).
 */
export function checkDataDir(path: string): DataDirCheck {
  if (!isAbsolute(path)) return { ok: false, detail: `the data folder ${path} must be an absolute path` };
  const bad = /[\s,()]/.exec(path)?.[0];
  if (bad === undefined) return { ok: true };
  const what = /\s/.test(bad) ? "a space" : bad === "," ? "a comma" : "parentheses";
  return {
    ok: false,
    detail: `the data folder ${path} contains ${what}; bots cannot read a folder whose path has spaces, commas or parentheses. Move it (e.g. to the repo's data/) or set ORCH_DATA_DIR.`,
  };
}
