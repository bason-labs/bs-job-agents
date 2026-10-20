// Builds the `--settings` hooks JSON that puts the site guard in front of Claude in Chrome
// (spike S2: a PreToolUse hook passed with --settings still applies with --setting-sources "").
import { buildHookCommand, resolveHookEntry } from "../../hooks/command.js";
import type { ClaudeHookSettings } from "../../hooks/settings.js";
import { InvalidAllowlistError, normalizeAllowlist } from "./allowlist.js";
import { CHROME_TOOL_PREFIX, SITE_GUARD_TOOLS } from "./guard.js";

export interface SiteGuardSettingsOptions {
  /** Domains the task may use; subdomains match. Apply: the approval token's domains. */
  allowedSites: readonly string[];
  /** JSONL audit log of every decision, e.g. data/transcripts/<taskId>-<attempt>.site-guard.jsonl. */
  logFile?: string;
  /** Claude in Chrome's MCP tool prefix (default `mcp__claude-in-chrome__`). */
  toolPrefix?: string;
  /** Node binary for the hook (default: the one running the orchestrator). */
  nodePath?: string;
  /** Seconds Claude Code waits for the hook (default 15). */
  timeoutSec?: number;
  /** The deviceId Ba chose for bots: select_browser may select it, nothing else. */
  browserId?: string | null;
}

/** The shell command that runs the site guard hook for this allowlist. */
export function siteGuardHookCommand(opts: SiteGuardSettingsOptions): string {
  const sites = normalizeAllowlist(opts.allowedSites);
  if (sites.length === 0) throw new InvalidAllowlistError("a browser task needs at least one allowed site");
  const args = sites.flatMap((s) => ["--allow", s]);
  if (opts.logFile) args.push("--log", opts.logFile);
  if (opts.toolPrefix && opts.toolPrefix !== CHROME_TOOL_PREFIX) args.push("--tool-prefix", opts.toolPrefix);
  if (opts.browserId) {
    // A deviceId is an opaque id; anything else never reaches the hook's command line.
    if (!/^[A-Za-z0-9-]{1,100}$/.test(opts.browserId)) throw new InvalidAllowlistError(`invalid Chrome browser id ${JSON.stringify(opts.browserId)}`);
    args.push("--browser", opts.browserId);
  }
  return buildHookCommand(resolveHookEntry(import.meta.url, "hook"), args, { nodePath: opts.nodePath });
}

/**
 * Settings for `claude -p --settings '<json>'`. One matcher per guarded tool name (exact names,
 * the form verified in spike S2). Throws InvalidAllowlistError for an empty or invalid list,
 * so a bad allowlist stops the spawn instead of producing a guard that blocks everything.
 */
export function buildSiteGuardSettings(opts: SiteGuardSettingsOptions): ClaudeHookSettings {
  const command = siteGuardHookCommand(opts);
  const prefix = opts.toolPrefix ?? CHROME_TOOL_PREFIX;
  return {
    hooks: {
      PreToolUse: SITE_GUARD_TOOLS.map((tool) => ({
        matcher: `${prefix}${tool}`,
        hooks: [{ type: "command" as const, command, timeout: opts.timeoutSec ?? 15 }],
      })),
    },
  };
}
