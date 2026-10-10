// Runner configuration: where the CLIs are and the MCP servers bots can name.
// Nothing machine-specific is hardcoded in bot.json; it all comes from here (env-overridable).
// Guard hooks are not runner config: the engine builds them per task with the bridges' builders
// and passes RunnerTask.hookSettings (coordinator decision).
import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LIMITS } from "@bs-job-agents/shared";

export interface McpStdioServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** All tool names of the server, if known: Claude then hides the ones a bot may not use. */
  knownTools?: string[];
}

export interface McpHttpServerConfig {
  /** Streamable HTTP endpoint, e.g. the orchestrator's own MCP server (W3a). */
  url: string;
  knownTools?: string[];
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export interface RunnerConfig {
  /** Claude Code CLI (spec §1.4: ~/.local/bin/claude). Env: CLAUDE_BIN. */
  claudeBin: string;
  /** Codex CLI bundled with ChatGPT.app (not on PATH). Env: CODEX_BIN. */
  codexBin: string;
  /** MCP servers by the name bot.json uses in mcpServers. */
  mcpServers: Record<string, McpServerConfig>;
  /** Claude's config dir; persisted bot sessions are deleted from <dir>/projects after each task. Env: CLAUDE_CONFIG_DIR. */
  claudeConfigDir: string;
  /** Codex user config, read only to list the plugins a browser bot must disable (§4.4). Env: CODEX_HOME. */
  codexUserConfigPath: string;
  /** The plugin Codex browser bots keep (spike S2). */
  codexChromePlugin: string;
  /** Where per-task work dirs (mcp.json, schema.json, last.json) are created and removed. */
  tmpRoot: string;
  /** SIGTERM → SIGKILL grace on a timeout or cancel. */
  killGraceMs: number;
  /** Delete the persisted CLI session after each task (it was kept only for the repair prompt). */
  cleanupSessions: boolean;
  /** UC-16: pause before the wall. */
  usagePauseUtilization: number;
  /** Environment for the CLIs (they need HOME for the subscription login). */
  env: NodeJS.ProcessEnv;
}

export const FIGMA_MCP_SERVER = "figma";
export const ORCHESTRATOR_MCP_SERVER = "orchestrator";

/** figma-console-mcp, pinned (spec §6.2, spike S3b). The orchestrator MCP server is added by W3a. */
export const DEFAULT_MCP_SERVERS: Record<string, McpServerConfig> = {
  [FIGMA_MCP_SERVER]: { command: "npx", args: ["-y", "figma-console-mcp@1.40.9"] },
};

export const DEFAULT_CODEX_BIN = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";

export function resolveRunnerConfig(over: Partial<RunnerConfig> = {}, env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const home = env.HOME ?? homedir();
  const codexHome = env.CODEX_HOME ?? join(home, ".codex");
  return {
    claudeBin: env.CLAUDE_BIN ?? join(home, ".local", "bin", "claude"),
    codexBin: env.CODEX_BIN ?? DEFAULT_CODEX_BIN,
    claudeConfigDir: env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"),
    codexUserConfigPath: join(codexHome, "config.toml"),
    codexChromePlugin: "chrome@openai-bundled",
    tmpRoot: tmpdir(),
    killGraceMs: 5_000,
    cleanupSessions: true,
    usagePauseUtilization: LIMITS.usagePauseUtilization,
    env,
    ...over,
    mcpServers: { ...DEFAULT_MCP_SERVERS, ...over.mcpServers },
  };
}

/** Plugin ids in a Codex config.toml (`[plugins."<id>"]` tables). */
export function listCodexPlugins(configToml: string): string[] {
  const ids: string[] = [];
  for (const m of configToml.matchAll(/^\s*\[plugins\."([^"]+)"\]\s*$/gm)) if (m[1] && !ids.includes(m[1])) ids.push(m[1]);
  return ids;
}

/** Plugins a Codex browser bot disables: every plugin in Ba's config except the Chrome one. */
export function codexPluginsToDisable(config: Pick<RunnerConfig, "codexUserConfigPath" | "codexChromePlugin">): string[] {
  if (!existsSync(config.codexUserConfigPath)) return [];
  return listCodexPlugins(readFileSync(config.codexUserConfigPath, "utf8")).filter((id) => id !== config.codexChromePlugin);
}

/** The repo's bots/ folder: walk up from this file to the folder that holds pnpm-workspace.yaml. */
export function defaultBotsDir(from: string = dirname(fileURLToPath(import.meta.url))): string {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return join(dir, "bots");
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no pnpm-workspace.yaml above ${from}`);
    dir = parent;
  }
}
