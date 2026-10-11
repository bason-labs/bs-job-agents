// `codex exec --json` command lines (spikes S1, S2, S4), verified live with codex-cli 0.162.0-alpha.17.2:
// - Non-browser bots: `--ignore-user-config` (Ba's login stays, his plugins and skills go) and
//   `--disable apps`: without it the built-in codex_apps server (ChatGPT connectors) answered a
//   web search although web_search was disabled.
// - Browser bots (§4.4): Ba's user config for the Chrome plugin and nothing else of his (PM2 M3):
//   every other plugin disabled (the plugin, never its server: switching a plugin's server off
//   fails config loading, spike S1), every MCP server his config defines switched off
//   (`mcp_servers.<id>.enabled=false`), his ChatGPT connectors off (`--disable apps`), no notify
//   program (`notify=[]`), and `--enable skip_host_skill_discovery --disable skill_search` (its
//   warning item is ignored).
//   Live check 2026-10-11 (codex-cli 0.162.0-alpha.17.2, Ba's real config.toml, research.scan argv,
//   a prompt that only listed its tools; nothing was opened or called): the session had the Chrome
//   plugin's `mcp__cua_repl.js` / `js_reset` and web search (`web.run`), and Codex's built-ins
//   (functions.exec / exec_command / apply_patch under the read-only sandbox, view_image, goals,
//   collaboration.* sub-agents, image_gen, clock). Nothing from node_repl, computer-use, ChatGPT
//   connectors or the 13 disabled plugins. The Chrome plugin's tools stay with node_repl off.
// - MCP servers via -c, with default_tools_approval_mode="approve" (exec fails MCP calls
//   otherwise) and enabled_tools as the allowlist (other tools are not offered).
// - `--output-schema` (strict JSON Schema) + `-o`; the first call is not --ephemeral so the one
//   repair prompt can `exec resume` the same thread; the runner deletes the thread afterwards.
import { join } from "node:path";
import type { BotDefinition, JsonSchema } from "@bs-job-agents/shared";
import type { RunnerConfig } from "../config.js";
import { RunnerConfigError } from "../errors.js";
import { displayArgs, promptLabel, type Invocation } from "../invocation.js";
import { codexToolConfig, type ToolPlan } from "../tools.js";
import { modelForEngine } from "../model.js";

/** TOML value for `-c key=value`: JSON strings and arrays of strings are valid TOML. */
const toml = (value: string | readonly string[]): string => JSON.stringify(value);

/** A TOML key segment: bare when it can be, else a quoted string. */
const tomlKey = (key: string): string => (/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key));

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface CodexInvocationInput {
  bot: BotDefinition;
  plan: ToolPlan;
  prompt: string;
  schema: JsonSchema;
  workDir: string;
  config: RunnerConfig;
  /** Browser bots: Ba's plugins other than Chrome (config.codexPluginsToDisable). */
  pluginsToDisable: readonly string[];
  /** Browser bots: the MCP servers Ba's config defines (config.codexUserMcpServers, PM2 M3). */
  mcpServersToDisable: readonly string[];
}

export const codexPaths = (workDir: string) => ({
  schema: join(workDir, "schema.json"),
  last: join(workDir, "last.json"),
  repair: join(workDir, "repair.json"),
});

const display = (args: string[]) => displayArgs(args, {}, promptLabel);

export function buildCodexInvocation(i: CodexInvocationInput): Invocation {
  const tools = codexToolConfig(i.plan);
  const paths = codexPaths(i.workDir);
  const args = ["exec", "--json", "--skip-git-repo-check"];
  if (tools.browser) {
    for (const id of i.pluginsToDisable) args.push("-c", `plugins.${JSON.stringify(id)}.enabled=false`);
    const own = new Set(tools.mcp.map((m) => m.server));
    for (const id of i.mcpServersToDisable) if (!own.has(id)) args.push("-c", `mcp_servers.${tomlKey(id)}.enabled=false`);
    args.push("-c", "notify=[]", "--disable", "apps");
    args.push("--enable", "skip_host_skill_discovery", "--disable", "skill_search");
  } else {
    args.push("--ignore-user-config", "--disable", "apps");
  }
  args.push("--sandbox", tools.sandbox, "-c", `web_search=${toml(tools.webSearch)}`);
  args.push("--output-schema", paths.schema, "-o", paths.last);
  for (const { server, enabledTools } of tools.mcp) {
    const cfg = i.config.mcpServers[server];
    if (!cfg) throw new RunnerConfigError(`MCP server ${server} is not configured in the runner config`);
    const key = `mcp_servers.${server}`;
    if ("url" in cfg) {
      args.push("-c", `${key}.url=${toml(cfg.url)}`);
    } else {
      args.push("-c", `${key}.command=${toml(cfg.command)}`, "-c", `${key}.args=${toml(cfg.args ?? [])}`);
      for (const [name, value] of Object.entries(cfg.env ?? {})) {
        if (!ENV_KEY.test(name)) throw new RunnerConfigError(`MCP server ${server}: invalid env name ${name}`);
        args.push("-c", `${key}.env.${name}=${toml(value)}`);
      }
    }
    args.push("-c", `${key}.default_tools_approval_mode="approve"`);
    if (enabledTools) args.push("-c", `${key}.enabled_tools=${toml(enabledTools)}`);
  }
  { const m = modelForEngine(i.bot.model, "codex"); if (m) args.push("-m", m); }
  args.push(i.prompt);
  return {
    command: i.config.codexBin,
    args,
    files: { [paths.schema]: `${JSON.stringify(i.schema, null, 2)}\n` },
    display: display(args),
  };
}

export interface CodexRepairInput {
  bot: BotDefinition;
  prompt: string;
  threadId: string;
  workDir: string;
  config: RunnerConfig;
}

/** The one repair prompt via `codex exec resume <thread>` (verified live: context kept, same thread id). */
export function buildCodexRepairInvocation(i: CodexRepairInput): Invocation {
  const paths = codexPaths(i.workDir);
  const args = [
    "exec",
    "resume",
    "--json",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--disable",
    "apps",
    "-c",
    'web_search="disabled"',
    "-c",
    'sandbox_mode="read-only"',
    "--output-schema",
    paths.schema,
    "-o",
    paths.repair,
    ...(modelForEngine(i.bot.model, "codex") ? ["-m", modelForEngine(i.bot.model, "codex") as string] : []),
    i.threadId,
    i.prompt,
  ];
  return { command: i.config.codexBin, args, files: {}, display: display(args) };
}

/** Deletes the persisted thread after the task (verified: `codex delete --force <uuid>`). */
export function buildCodexDeleteInvocation(threadId: string, config: RunnerConfig): Invocation {
  const args = ["delete", "--force", threadId];
  return { command: config.codexBin, args, files: {}, display: args };
}
