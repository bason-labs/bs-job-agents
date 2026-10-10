// `claude -p` command lines (spike S1/S2, spec §5.5 step 2), verified live with Claude Code 2.1.296:
// - `--setting-sources ""` isolates the bot from Ba's plugins, hooks and CLAUDE.md; never --bare / --safe-mode.
// - `--settings` turns auto memory off (otherwise the CLI keeps a second, hidden memory per bot folder,
//   against rule 2) and adds the PreToolUse guards.
// - `--strict-mcp-config` drops Ba's own MCP servers and claude.ai connectors; --chrome still works.
// - `--session-id` + session persistence on the first call, so the one repair prompt can `--resume`
//   the same session; the repair runs with every tool off and `--no-session-persistence`.
import { join } from "node:path";
import type { BotDefinition, JsonSchema } from "@bs-job-agents/shared";
import { FIGMA_MCP_SERVER, hookCommandLine, type RunnerConfig } from "../config.js";
import { RunnerConfigError } from "../errors.js";
import { displayArgs, promptLabel, schemaLabel, type Invocation } from "../invocation.js";
import { chromeToolName, claudeToolFlags, mcpToolName, type ToolPlan } from "../tools.js";

/** Navigation tools the site guard checks (§4.4). tabs_create_mcp is not matched: it opens a blank tab. */
export const SITE_GUARD_MATCHER = `${chromeToolName("navigate")}|${chromeToolName("javascript_tool")}`;
/** figma_execute runs arbitrary plugin code; the guard rejects code touching pages other than Drafts (§6.2). */
export const FIGMA_GUARD_MATCHER = mcpToolName(FIGMA_MCP_SERVER, "figma_execute");

const BASE_SETTINGS = { autoMemoryEnabled: false };

export interface ClaudeSettingsInput {
  plan: ToolPlan;
  allowedSites: readonly string[];
  config: Pick<RunnerConfig, "hooks">;
}

export function claudeSettings({ plan, allowedSites, config }: ClaudeSettingsInput): Record<string, unknown> {
  const preToolUse: unknown[] = [];
  if (plan.chrome) {
    const guard = config.hooks.siteGuard;
    if (!guard) throw new RunnerConfigError("the site guard hook is not configured; a Claude browser bot never runs without it (§4.4)");
    if (allowedSites.length === 0) throw new RunnerConfigError("a browser task needs at least one allowed site");
    preToolUse.push({
      matcher: SITE_GUARD_MATCHER,
      hooks: [{ type: "command", command: hookCommandLine(guard, ["--sites", allowedSites.join(",")]) }],
    });
  }
  if (plan.mcp.some((m) => m.server === FIGMA_MCP_SERVER)) {
    const guard = config.hooks.figmaGuard;
    if (!guard) throw new RunnerConfigError("the Figma guard hook is not configured; a Figma bot never runs without it (§6.2)");
    preToolUse.push({ matcher: FIGMA_GUARD_MATCHER, hooks: [{ type: "command", command: hookCommandLine(guard) }] });
  }
  return preToolUse.length > 0 ? { ...BASE_SETTINGS, hooks: { PreToolUse: preToolUse } } : { ...BASE_SETTINGS };
}

/** The per-task mcp.json: only the bot's own servers, from the runner config. */
export function claudeMcpConfig(plan: ToolPlan, config: Pick<RunnerConfig, "mcpServers">): { mcpServers: Record<string, unknown> } | null {
  if (plan.mcp.length === 0) return null;
  const mcpServers: Record<string, unknown> = {};
  for (const { server } of plan.mcp) {
    const cfg = config.mcpServers[server];
    if (!cfg) throw new RunnerConfigError(`MCP server ${server} is not configured in the runner config`);
    mcpServers[server] =
      "url" in cfg
        ? { type: "http", url: cfg.url }
        : { type: "stdio", command: cfg.command, args: cfg.args ?? [], ...(cfg.env ? { env: cfg.env } : {}) };
  }
  return { mcpServers };
}

export interface ClaudeInvocationInput {
  bot: BotDefinition;
  plan: ToolPlan;
  prompt: string;
  schema: JsonSchema;
  sessionId: string;
  workDir: string;
  readDirs: readonly string[];
  allowedSites: readonly string[];
  config: RunnerConfig;
}

const display = (args: string[]) => displayArgs(args, { "-p": promptLabel, "--json-schema": schemaLabel });

export function buildClaudeInvocation(i: ClaudeInvocationInput): Invocation {
  const knownTools = Object.fromEntries(Object.entries(i.config.mcpServers).map(([name, cfg]) => [name, cfg.knownTools]));
  const flags = claudeToolFlags(i.plan, { readDirs: i.readDirs, mcpKnownTools: knownTools });
  const mcp = claudeMcpConfig(i.plan, i.config);
  const mcpPath = join(i.workDir, "mcp.json");
  const settings = claudeSettings({ plan: i.plan, allowedSites: i.allowedSites, config: i.config });
  const args = [
    "-p",
    i.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--tools",
    flags.tools.join(","),
    ...(flags.allowed.length > 0 ? ["--allowedTools", ...flags.allowed] : []),
    ...(flags.disallowed.length > 0 ? ["--disallowedTools", ...flags.disallowed] : []),
    ...(mcp ? ["--mcp-config", mcpPath] : []),
    "--strict-mcp-config",
    "--settings",
    JSON.stringify(settings),
    "--json-schema",
    JSON.stringify(i.schema),
    "--session-id",
    i.sessionId,
    "--permission-prompts",
    "none",
    ...(i.bot.model ? ["--model", i.bot.model] : []),
    ...(flags.chrome ? ["--chrome"] : []),
    ...(flags.addDirs.length > 0 ? ["--add-dir", ...flags.addDirs] : []),
  ];
  return {
    command: i.config.claudeBin,
    args,
    files: mcp ? { [mcpPath]: `${JSON.stringify(mcp, null, 2)}\n` } : {},
    display: display(args),
  };
}

export interface ClaudeRepairInput {
  bot: BotDefinition;
  prompt: string;
  schema: JsonSchema;
  sessionId: string;
  config: RunnerConfig;
}

/** The one repair prompt, in the same session (verified live: context kept, same session id). */
export function buildClaudeRepairInvocation(i: ClaudeRepairInput): Invocation {
  const args = [
    "-p",
    i.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--tools",
    "",
    "--strict-mcp-config",
    "--settings",
    JSON.stringify(BASE_SETTINGS),
    "--json-schema",
    JSON.stringify(i.schema),
    "--resume",
    i.sessionId,
    "--no-session-persistence",
    "--permission-prompts",
    "none",
    ...(i.bot.model ? ["--model", i.bot.model] : []),
  ];
  return { command: i.config.claudeBin, args, files: {}, display: display(args) };
}
