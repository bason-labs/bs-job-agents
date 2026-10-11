// `claude -p` command lines (spike S1/S2, spec §5.5 step 2), verified live with Claude Code 2.1.296:
// - `--setting-sources ""` isolates the bot from Ba's plugins, hooks and CLAUDE.md; never --bare / --safe-mode.
// - `--settings` turns auto memory off (otherwise the CLI keeps a second, hidden memory per bot folder,
//   against rule 2) and adds the PreToolUse guards the engine built for this task (coordinator
//   decision: RunnerTask.hookSettings, from W2c's site guard and Figma guard builders).
// - `--strict-mcp-config` drops Ba's own MCP servers and claude.ai connectors; --chrome still works.
// - `--session-id` + session persistence on the first call, so the one repair prompt can `--resume`
//   the same session; the repair runs with every tool off and `--no-session-persistence`.
import { join } from "node:path";
import type { BotDefinition, JsonSchema } from "@bs-job-agents/shared";
import type { ClaudeHookMatcher, ClaudeHookSettings } from "../../bridges/hooks/settings.js";
import { FIGMA_MCP_SERVER, type RunnerConfig } from "../config.js";
import { RunnerConfigError, TaskSetupError } from "../errors.js";
import { displayArgs, promptLabel, schemaLabel, type Invocation } from "../invocation.js";
import { chromeToolName, claudeToolFlags, mcpToolName, type ToolPlan } from "../tools.js";
import { modelForEngine } from "../model.js";

/** The navigation tool a Claude browser task's site guard must cover (§4.4, §10.2 rule 7). */
export const SITE_GUARDED_TOOL = chromeToolName("navigate");
/** figma_execute runs arbitrary plugin code; a Figma task's Drafts-only guard must cover it (§6.2). */
export const FIGMA_GUARDED_TOOL = mcpToolName(FIGMA_MCP_SERVER, "figma_execute");

const BASE_SETTINGS = { autoMemoryEnabled: false };

/**
 * Whether a PreToolUse `matcher` applies to `tool`, by Claude Code's rules: "" or "*" match every
 * tool; a plain name (letters, digits, `_`, `|`) matches exactly, `|` separating alternatives;
 * anything else is a regular expression. An invalid expression matches nothing.
 */
export function hookMatcherCovers(matcher: string, tool: string): boolean {
  if (matcher === "" || matcher === "*") return true;
  if (/^[A-Za-z0-9_|]+$/.test(matcher)) return matcher.split("|").some((name) => name.trim() === tool);
  try {
    return new RegExp(matcher).test(tool);
  } catch {
    return false;
  }
}

/** Some matcher with a non-empty command applies to `tool`. */
function guards(matchers: readonly ClaudeHookMatcher[], tool: string): boolean {
  return matchers.some((m) => hookMatcherCovers(m.matcher, tool) && m.hooks.some((h) => h.type === "command" && h.command.trim() !== ""));
}

export interface ClaudeSettingsInput {
  plan: ToolPlan;
  /** RunnerTask.hookSettings: the task's guards, built by the engine. */
  hookSettings: ClaudeHookSettings | undefined;
}

/**
 * Base settings plus the engine's PreToolUse hooks (only `hooks` is taken from them). Fails closed:
 * a task with Chrome tools needs a guard on navigate, a task with the Figma bridge one on
 * figma_execute; the runner never builds a guard of its own.
 */
export function claudeSettings({ plan, hookSettings }: ClaudeSettingsInput): Record<string, unknown> {
  const preToolUse = hookSettings?.hooks?.PreToolUse ?? [];
  if (plan.chrome && !guards(preToolUse, SITE_GUARDED_TOOL)) {
    throw new TaskSetupError(
      `a Claude browser task never runs without the site guard hook (§4.4): its hook settings must guard ${SITE_GUARDED_TOOL}`,
    );
  }
  if (plan.mcp.some((m) => m.server === FIGMA_MCP_SERVER) && !guards(preToolUse, FIGMA_GUARDED_TOOL)) {
    throw new TaskSetupError(`a Figma task never runs without the Figma guard hook (§6.2): its hook settings must guard ${FIGMA_GUARDED_TOOL}`);
  }
  return preToolUse.length > 0 ? { ...BASE_SETTINGS, hooks: { PreToolUse: [...preToolUse] } } : { ...BASE_SETTINGS };
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
  /** RunnerTask.hookSettings (the site guard carries the task's allowed sites). */
  hookSettings?: ClaudeHookSettings | undefined;
  config: RunnerConfig;
}

const display = (args: string[]) => displayArgs(args, { "-p": promptLabel, "--json-schema": schemaLabel });

export function buildClaudeInvocation(i: ClaudeInvocationInput): Invocation {
  const knownTools = Object.fromEntries(Object.entries(i.config.mcpServers).map(([name, cfg]) => [name, cfg.knownTools]));
  const flags = claudeToolFlags(i.plan, { readDirs: i.readDirs, mcpKnownTools: knownTools });
  const mcp = claudeMcpConfig(i.plan, i.config);
  const mcpPath = join(i.workDir, "mcp.json");
  const settings = claudeSettings({ plan: i.plan, hookSettings: i.hookSettings });
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
    ...(modelForEngine(i.bot.model, "claude") ? ["--model", modelForEngine(i.bot.model, "claude") as string] : []),
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
    ...(modelForEngine(i.bot.model, "claude") ? ["--model", modelForEngine(i.bot.model, "claude") as string] : []),
  ];
  return { command: i.config.claudeBin, args, files: {}, display: display(args) };
}
