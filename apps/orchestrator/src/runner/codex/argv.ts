// `codex exec --json` command lines (spikes S1, S2, S4), verified live with codex-cli 0.162.0-alpha.17.2:
// - Non-browser bots: `--ignore-user-config` (Ba's login stays, his plugins and skills go) and
//   `--disable apps`: without it the built-in codex_apps server (ChatGPT connectors) answered a
//   web search although web_search was disabled.
// - Browser bots (§4.4): Ba's user config for the Chrome plugin, every other plugin disabled,
//   `--enable skip_host_skill_discovery --disable skill_search` (its warning item is ignored).
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

/** TOML value for `-c key=value`: JSON strings and arrays of strings are valid TOML. */
const toml = (value: string | readonly string[]): string => JSON.stringify(value);

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
  if (i.bot.model) args.push("-m", i.bot.model);
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
    ...(i.bot.model ? ["-m", i.bot.model] : []),
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
