// Runner configuration: where the CLIs are and the MCP servers bots can name.
// Nothing machine-specific is hardcoded in bot.json; it all comes from here (env-overridable).
// Guard hooks are not runner config: the engine builds them per task with the bridges' builders
// and passes RunnerTask.hookSettings (coordinator decision).
import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LIMITS } from "@bs-job-agents/shared";
import { FIGMA_CONSOLE_MCP_VERSION } from "../bridges/figma/constants.js";
import { resolveFigmaConsoleMcp } from "../bridges/figma/mcp.js";
import { FIGMA_CONSOLE_MCP_TOOLS } from "../bridges/figma/tools.js";

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
  /**
   * Codex user config, read only to list what a browser bot must switch off: every plugin but
   * Chrome (§4.4) and every MCP server Ba defined (PM2 M3). Env: CODEX_HOME.
   */
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

/**
 * figma-console-mcp, pinned (spec §6.2, spike S3b): the copy the orchestrator installs (the same
 * one its own FigmaBridge runs), started by this node binary. No npx: no PATH lookup (a launchd
 * service has a minimal PATH) and no download when a CV task starts. npx only if it is missing.
 */
function figmaConsoleMcpServer(): McpStdioServerConfig {
  // PM2 S12: its full tool list, so a bot sees only the Figma tools it may use.
  const knownTools = [...FIGMA_CONSOLE_MCP_TOOLS];
  try {
    return { command: process.execPath, args: [resolveFigmaConsoleMcp().serverPath], knownTools };
  } catch {
    return { command: "npx", args: ["-y", `figma-console-mcp@${FIGMA_CONSOLE_MCP_VERSION}`], knownTools };
  }
}

/** The orchestrator MCP server is added by W3a. */
export const DEFAULT_MCP_SERVERS: Record<string, McpServerConfig> = {
  [FIGMA_MCP_SERVER]: figmaConsoleMcpServer(),
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

/** One TOML key path, e.g. `mcp_servers."computer-use".env` → ["mcp_servers", "computer-use", "env"]; null if it is not one. */
function parseKeyPath(text: string): { path: string[]; rest: string } | null {
  const path: string[] = [];
  let i = 0;
  const skip = () => {
    while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
  };
  for (;;) {
    skip();
    const ch = text[i];
    if (ch === '"') {
      // A basic string key; JSON reads the escapes TOML shares with it.
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (j >= text.length) return null;
      try {
        path.push(JSON.parse(text.slice(i, j + 1)) as string);
      } catch {
        return null;
      }
      i = j + 1;
    } else if (ch === "'") {
      const j = text.indexOf("'", i + 1);
      if (j < 0) return null;
      path.push(text.slice(i + 1, j));
      i = j + 1;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
      if (!m) return null;
      path.push(m[0]);
      i += m[0].length;
    }
    skip();
    if (text[i] !== ".") return { path, rest: text.slice(i) };
    i++;
  }
}

/** Multi-line string delimiters a line opens or closes (an odd count toggles). */
function multilineDelimiter(line: string, open: string | null): string | null {
  let state = open;
  for (const delim of ['"""', "'''"]) {
    if (state !== null && state !== delim) continue;
    const count = line.split(delim).length - 1;
    if (count % 2 === 1) state = state === null ? delim : null;
  }
  return state;
}

/**
 * Every MCP server a Codex config.toml defines (PM2 M3), in order: `[mcp_servers.<id>]` tables and
 * their sub-tables, `[[mcp_servers.<id>]]`, keys of an `[mcp_servers]` table, and dotted keys such
 * as `mcp_servers.<id>.command = …`. Bare, "quoted" and 'literal' keys; comments and multi-line
 * strings are skipped. Line-based on purpose: anything unusual it cannot read leaves a server ON,
 * so the live tool check (runbook) stays the backstop.
 */
export function listCodexMcpServers(configToml: string): string[] {
  const ids: string[] = [];
  const add = (path: readonly string[]) => {
    if (path[0] === "mcp_servers" && path.length >= 2 && !ids.includes(path[1]!)) ids.push(path[1]!);
  };
  let table: string[] = [];
  let multiline: string | null = null;
  for (const raw of configToml.split(/\r?\n/)) {
    if (multiline !== null) {
      multiline = multilineDelimiter(raw, multiline);
      continue;
    }
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const header = /^\[\[?(.*?)\]\]?\s*(#.*)?$/.exec(line);
    if (header) {
      const parsed = parseKeyPath(header[1]!);
      table = parsed && parsed.rest.trim() === "" ? parsed.path : [];
      add(table);
      continue;
    }
    const kv = parseKeyPath(line);
    if (kv && kv.rest.trimStart().startsWith("=")) add([...table, ...kv.path]);
    multiline = multilineDelimiter(line, null);
  }
  return ids;
}

/** MCP servers a Codex browser bot switches off: every one in Ba's config (PM2 M3). */
export function codexUserMcpServers(config: Pick<RunnerConfig, "codexUserConfigPath">): string[] {
  if (!existsSync(config.codexUserConfigPath)) return [];
  return listCodexMcpServers(readFileSync(config.codexUserConfigPath, "utf8"));
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
