// Shell command for a hook entry script, for Claude Code `--settings` hooks.
//
// Claude Code runs hook commands through a shell. The command ends in `|| exit 2` so that a
// hook that cannot even start (missing file, module error) blocks the tool instead of letting
// it run: only exit code 2 blocks a PreToolUse call.
import { createRequire } from "node:module";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface HookEntry {
  /** Absolute path of the entry script. */
  path: string;
  /** `dist`: compiled JavaScript run by node. `source`: TypeScript run through tsx (dev, tests). */
  runtime: "dist" | "source";
}

/** POSIX single-quote quoting. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The entry script `<name>` next to the calling module, in the same form the orchestrator is
 * running: `dist/.../<name>.js` under node, `src/.../<name>.ts` under tsx or Vitest.
 */
export function resolveHookEntry(callerModuleUrl: string, name: string): HookEntry {
  const callerPath = fileURLToPath(callerModuleUrl);
  const runtime = extname(callerPath) === ".ts" ? "source" : "dist";
  return { path: join(dirname(callerPath), `${basename(name)}${runtime === "source" ? ".ts" : ".js"}`), runtime };
}

let tsxLoader: string | undefined;
function tsxLoaderUrl(): string {
  tsxLoader ??= pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  return tsxLoader;
}

export interface HookCommandOptions {
  /** Node binary; defaults to the one running the orchestrator, so hooks use the same version. */
  nodePath?: string;
}

export function buildHookCommand(entry: HookEntry, args: readonly string[], opts: HookCommandOptions = {}): string {
  const parts = [opts.nodePath ?? process.execPath];
  if (entry.runtime === "source") parts.push("--import", tsxLoaderUrl());
  parts.push(entry.path, ...args);
  return `${parts.map(shellQuote).join(" ")} || exit 2`;
}
