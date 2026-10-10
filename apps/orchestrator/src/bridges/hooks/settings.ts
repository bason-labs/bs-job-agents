// The part of Claude Code's settings JSON that `--settings` hooks use (spike S1/S2).

export interface ClaudeHookCommand {
  type: "command";
  command: string;
  /** Seconds before Claude Code gives up on the hook. */
  timeout?: number;
}

export interface ClaudeHookMatcher {
  /** Tool name or regex, e.g. `mcp__claude-in-chrome__navigate`, `mcp__figma__.*`. */
  matcher: string;
  hooks: ClaudeHookCommand[];
}

export interface ClaudeHookSettings {
  hooks: { PreToolUse: ClaudeHookMatcher[] };
}

/** Combines the hooks of several guards into one settings object for one `--settings` flag. */
export function mergeHookSettings(...parts: ClaudeHookSettings[]): ClaudeHookSettings {
  return { hooks: { PreToolUse: parts.flatMap((p) => p.hooks.PreToolUse) } };
}
