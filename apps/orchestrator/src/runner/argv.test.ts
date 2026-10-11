// Golden argv per bot (spike S1/S2/S4 flags), built from the real bots/<name>/bot.json.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getBotOutputJsonSchema, resolveOutputSchemaName, type BotDefinition } from "@bs-job-agents/shared";
import { FIGMA_CONSOLE_MCP_TOOLS } from "../bridges/figma/tools.js";
import type { ClaudeHookSettings } from "../bridges/hooks/settings.js";
import { loadBotDefinition } from "./bots.js";
import { buildClaudeInvocation, buildClaudeRepairInvocation, claudeSettings, hookMatcherCovers } from "./claude/argv.js";
import { buildCodexInvocation, buildCodexRepairInvocation } from "./codex/argv.js";
import { RunnerConfigError, TaskSetupError } from "./errors.js";
import { DEFAULT_MCP_SERVERS, defaultBotsDir, resolveRunnerConfig, type RunnerConfig } from "./config.js";
import { planTools } from "./tools.js";

const BOTS = defaultBotsDir();
const bot = (name: string): BotDefinition => loadBotDefinition(join(BOTS, name));
const SID = "00000000-0000-4000-8000-000000000000";
const W = "/tmp/bsja-w";

const CONFIG: RunnerConfig = resolveRunnerConfig(
  {
    claudeBin: "/Users/ba/.local/bin/claude",
    codexBin: "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
    mcpServers: { orchestrator: { url: "http://127.0.0.1:4100/mcp" } },
  },
  { HOME: "/Users/ba" },
);

/** What the engine builds per task with W2c's builders (coordinator decision): one matcher per guarded tool. */
const SITE_HOOKS: ClaudeHookSettings = {
  hooks: {
    PreToolUse: ["navigate", "javascript_tool", "browser_batch"].map((t) => ({
      matcher: `mcp__claude-in-chrome__${t}`,
      hooks: [{ type: "command" as const, command: "'/n/node' '/repo/dist/bridges/chrome/site-guard/hook.js' '--allow' 'itviec.com' || exit 2", timeout: 15 }],
    })),
  },
};
const FIGMA_HOOKS: ClaudeHookSettings = {
  hooks: {
    PreToolUse: [
      {
        matcher: "mcp__figma__.*",
        hooks: [{ type: "command", command: "'/n/node' '/repo/dist/bridges/figma/guard-hook.js' '--config' '/repo/data/tasks/9/figma-guard.json' || exit 2", timeout: 15 }],
      },
    ],
  },
};

function claude(name: string, kind: string, extra: { readDirs?: string[]; hookSettings?: ClaudeHookSettings } = {}) {
  const def = bot(name);
  return buildClaudeInvocation({
    bot: def,
    plan: planTools(def),
    prompt: "PROMPT",
    schema: getBotOutputJsonSchema(resolveOutputSchemaName(def, kind)),
    sessionId: SID,
    workDir: W,
    readDirs: extra.readDirs ?? [],
    hookSettings: extra.hookSettings,
    config: CONFIG,
  });
}

function codex(name: string, kind: string, plugins: string[] = [], mcpServers: string[] = []) {
  const def = bot(name);
  return buildCodexInvocation({
    bot: def,
    plan: planTools(def),
    prompt: "PROMPT",
    schema: getBotOutputJsonSchema(resolveOutputSchemaName(def, kind)),
    workDir: W,
    config: CONFIG,
    pluginsToDisable: plugins,
    mcpServersToDisable: mcpServers,
  });
}

const chrome = (t: string) => `mcp__claude-in-chrome__${t}`;
const SETTINGS = '{"autoMemoryEnabled":false}';

describe("Claude argv (spike S1, spec §5.5)", () => {
  it("lead", () => {
    const inv = claude("lead", "chat");
    expect(inv.command).toBe("/Users/ba/.local/bin/claude");
    expect(inv.display).toEqual([
      "-p", "<prompt: 6 chars>",
      "--output-format", "stream-json", "--verbose",
      "--setting-sources", "",
      "--disable-slash-commands",
      "--tools", "",
      "--allowedTools",
      "mcp__orchestrator__start_workflow",
      "mcp__orchestrator__create_task",
      "mcp__orchestrator__get_status",
      "mcp__orchestrator__get_result",
      "mcp__orchestrator__message_user",
      "mcp__orchestrator__propose_workflow",
      "--mcp-config", `${W}/mcp.json`,
      "--strict-mcp-config",
      "--settings", SETTINGS,
      "--json-schema", "<schema: LeadOutput>",
      "--session-id", SID,
      "--permission-prompts", "none",
      "--model", "sonnet",
    ]);
    expect(JSON.parse(inv.files[`${W}/mcp.json`]!)).toEqual({ mcpServers: { orchestrator: { type: "http", url: "http://127.0.0.1:4100/mcp" } } });
  });

  it("cv", () => {
    const inv = claude("cv", "tailor", { readDirs: ["/repo/data/master"], hookSettings: FIGMA_HOOKS });
    // PM2 S12: the pinned figma-console-mcp's other 118 tools are hidden, so CV sees only its 3.
    const cvTools = ["figma_get_status", "figma_execute", "figma_capture_screenshot"];
    const hidden = FIGMA_CONSOLE_MCP_TOOLS.filter((t) => !cvTools.includes(t)).map((t) => `mcp__figma__${t}`);
    expect(hidden).toHaveLength(118);
    expect(inv.display).toEqual([
      "-p", "<prompt: 6 chars>",
      "--output-format", "stream-json", "--verbose",
      "--setting-sources", "",
      "--disable-slash-commands",
      "--tools", "Read",
      "--allowedTools",
      "Read(//repo/data/master/**)",
      "mcp__figma__figma_get_status",
      "mcp__figma__figma_execute",
      "mcp__figma__figma_capture_screenshot",
      "--disallowedTools",
      ...hidden,
      "--mcp-config", `${W}/mcp.json`,
      "--strict-mcp-config",
      "--settings",
      JSON.stringify({ autoMemoryEnabled: false, ...FIGMA_HOOKS }),
      "--json-schema", "<schema: CvOutput>",
      "--session-id", SID,
      "--permission-prompts", "none",
      "--model", "sonnet",
      "--add-dir", "/repo/data/master",
    ]);
    const figma = DEFAULT_MCP_SERVERS.figma as { command: string; args: string[] };
    expect(JSON.parse(inv.files[`${W}/mcp.json`]!)).toEqual({
      mcpServers: { figma: { type: "stdio", command: process.execPath, args: figma.args } },
    });
    expect(figma.args[0]).toMatch(/figma-console-mcp\/dist\/local\.js$/);
  });

  it("apply", () => {
    const inv = claude("apply", "submit", { readDirs: ["/repo/data/applications/7"], hookSettings: SITE_HOOKS });
    const hidden = [
      "browser_batch", "gif_creator", "javascript_tool", "list_connected_browsers", "read_console_messages", "read_network_requests",
      "resize_window", "select_browser", "shortcuts_execute", "shortcuts_list", "switch_browser", "upload_image",
    ].map(chrome);
    expect(inv.display).toEqual([
      "-p", "<prompt: 6 chars>",
      "--output-format", "stream-json", "--verbose",
      "--setting-sources", "",
      "--disable-slash-commands",
      "--tools", "Read",
      "--allowedTools",
      "Read(//repo/data/applications/7/**)",
      ...["navigate", "get_page_text", "read_page", "find", "tabs_context_mcp", "tabs_create_mcp", "tabs_close_mcp", "computer", "form_input", "file_upload"].map(chrome),
      "--disallowedTools",
      ...hidden,
      "--strict-mcp-config",
      "--settings",
      JSON.stringify({ autoMemoryEnabled: false, ...SITE_HOOKS }),
      "--json-schema", "<schema: ApplyOutput>",
      "--session-id", SID,
      "--permission-prompts", "none",
      "--model", "sonnet",
      "--chrome",
      "--add-dir", "/repo/data/applications/7",
    ]);
    expect(inv.files).toEqual({});
  });

  it("passes the prompt and the strict schema verbatim", () => {
    const inv = claude("cv", "tailor", { hookSettings: FIGMA_HOOKS });
    expect(inv.args[1]).toBe("PROMPT");
    expect(JSON.parse(inv.args[inv.args.indexOf("--json-schema") + 1]!)).toEqual(getBotOutputJsonSchema("CvOutput"));
  });

  it("adds --model only when bot.json sets one", () => {
    const def = { ...bot("qa"), engine: "claude" as const, model: "haiku" };
    const inv = buildClaudeInvocation({
      bot: def, plan: planTools(def), prompt: "P", schema: getBotOutputJsonSchema("QaOutput"),
      sessionId: SID, workDir: W, readDirs: [], config: CONFIG,
    });
    expect(inv.args.slice(inv.args.indexOf("--model"), inv.args.indexOf("--model") + 2)).toEqual(["--model", "haiku"]);
  });

  it("never uses the flags the spike ruled out", () => {
    for (const [name, kind] of [["lead", "chat"], ["cv", "tailor"], ["apply", "submit"]] as const) {
      const args = claude(name, kind, { hookSettings: name === "cv" ? FIGMA_HOOKS : SITE_HOOKS }).args;
      for (const banned of ["--bare", "--safe-mode", "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions"]) {
        expect(args, `${name} ${banned}`).not.toContain(banned);
      }
      expect(args).toContain("--strict-mcp-config");
    }
  });

  it("merges the engine's hook settings into the base settings and keeps nothing else from them", () => {
    const sneaky = { ...SITE_HOOKS, permissions: { allow: ["Bash"] }, env: { X: "1" } } as unknown as ClaudeHookSettings;
    expect(claudeSettings({ plan: planTools(bot("apply")), hookSettings: sneaky })).toEqual({
      autoMemoryEnabled: false,
      hooks: { PreToolUse: SITE_HOOKS.hooks.PreToolUse },
    });
    // Both guards at once (a Claude bot with Chrome and Figma) keep every matcher, in order.
    const both: ClaudeHookSettings = { hooks: { PreToolUse: [...SITE_HOOKS.hooks.PreToolUse, ...FIGMA_HOOKS.hooks.PreToolUse] } };
    const cv = bot("cv");
    const browsingCv = { ...cv, allowedTools: [...cv.allowedTools, "chrome:read"], browser: { mode: "read" as const, allowedSites: ["figma.com"], sitesFromApproval: false } };
    const merged = claudeSettings({ plan: planTools(browsingCv), hookSettings: both }) as unknown as ClaudeHookSettings;
    expect(merged.hooks.PreToolUse.map((m) => m.matcher)).toEqual([...SITE_HOOKS.hooks.PreToolUse.map((m) => m.matcher), "mcp__figma__.*"]);
    // Bots without Chrome or Figma run with the base settings only.
    expect(claudeSettings({ plan: planTools(bot("lead")), hookSettings: undefined })).toEqual({ autoMemoryEnabled: false });
  });

  it("never builds a site guard of its own: the config has no hooks and no --sites flag appears", () => {
    expect(CONFIG).not.toHaveProperty("hooks");
    const args = claude("apply", "submit", { readDirs: ["/repo/data/applications/7"], hookSettings: SITE_HOOKS }).args;
    expect(args.join(" ")).not.toContain("--sites");
  });

  it("refuses a browser task without the site guard, a Figma task without the Figma guard, or an unknown MCP server", () => {
    const apply = planTools(bot("apply"));
    const cv = planTools(bot("cv"));
    expect(() => claudeSettings({ plan: apply, hookSettings: undefined })).toThrow(TaskSetupError);
    expect(() => claudeSettings({ plan: apply, hookSettings: undefined })).toThrow(/site guard/);
    expect(() => claudeSettings({ plan: apply, hookSettings: FIGMA_HOOKS })).toThrow(/site guard/);
    // A guard on javascript_tool alone leaves navigate unguarded.
    const jsOnly: ClaudeHookSettings = { hooks: { PreToolUse: [SITE_HOOKS.hooks.PreToolUse[1]!] } };
    expect(() => claudeSettings({ plan: apply, hookSettings: jsOnly })).toThrow(/site guard/);
    // A matcher with no command guards nothing.
    const empty: ClaudeHookSettings = { hooks: { PreToolUse: [{ matcher: "mcp__claude-in-chrome__navigate", hooks: [] }] } };
    expect(() => claudeSettings({ plan: apply, hookSettings: empty })).toThrow(/site guard/);
    expect(() => claudeSettings({ plan: cv, hookSettings: undefined })).toThrow(/Figma guard/);
    expect(() => claudeSettings({ plan: cv, hookSettings: SITE_HOOKS })).toThrow(/Figma guard/);
    const lead = bot("lead");
    expect(() =>
      buildClaudeInvocation({
        bot: lead, plan: planTools(lead), prompt: "P", schema: getBotOutputJsonSchema("LeadOutput"),
        sessionId: SID, workDir: W, readDirs: [], config: resolveRunnerConfig({}, { HOME: "/Users/ba" }),
      }),
    ).toThrow(RunnerConfigError);
  });

  it("matches tool names the way Claude Code does: exact names, |-lists, regular expressions, * and empty", () => {
    const nav = chrome("navigate");
    expect(hookMatcherCovers(nav, nav)).toBe(true);
    expect(hookMatcherCovers("mcp__claude-in-chrome__.*", nav)).toBe(true);
    expect(hookMatcherCovers(`${nav}|${chrome("javascript_tool")}`, nav)).toBe(true);
    expect(hookMatcherCovers("*", nav)).toBe(true);
    expect(hookMatcherCovers("", nav)).toBe(true);
    expect(hookMatcherCovers("navigate", nav)).toBe(false);
    expect(hookMatcherCovers("Read|Write", "Read")).toBe(true);
    expect(hookMatcherCovers("Read|Write", "ReadX")).toBe(false);
    expect(hookMatcherCovers("mcp__figma__.*", "mcp__figma__figma_execute")).toBe(true);
    expect(hookMatcherCovers("mcp__other__.*", "mcp__figma__figma_execute")).toBe(false);
    expect(hookMatcherCovers("(", nav)).toBe(false);
  });

  it("repair: same session via --resume, no persistence, every tool off", () => {
    const inv = buildClaudeRepairInvocation({ bot: bot("apply"), prompt: "FIX", schema: getBotOutputJsonSchema("ApplyOutput"), sessionId: SID, config: CONFIG });
    expect(inv.display).toEqual([
      "-p", "<prompt: 3 chars>",
      "--output-format", "stream-json", "--verbose",
      "--setting-sources", "",
      "--disable-slash-commands",
      "--tools", "",
      "--strict-mcp-config",
      "--settings", SETTINGS,
      "--json-schema", "<schema: ApplyOutput>",
      "--resume", SID,
      "--no-session-persistence",
      "--permission-prompts", "none",
      "--model", "sonnet",
    ]);
  });
});

describe("Codex argv (spike S1/S2/S4)", () => {
  it("qa (non-browser): no user config, no ChatGPT apps, read-only, no web search", () => {
    const inv = codex("qa", "review");
    expect(inv.command).toBe("/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex");
    expect(inv.display).toEqual([
      "exec", "--json", "--skip-git-repo-check",
      "--ignore-user-config", "--disable", "apps",
      "--sandbox", "read-only",
      "-c", 'web_search="disabled"',
      "--output-schema", `${W}/schema.json`,
      "-o", `${W}/last.json`,
      "<prompt: 6 chars>",
    ]);
    expect(JSON.parse(inv.files[`${W}/schema.json`]!)).toEqual(getBotOutputJsonSchema("QaOutput"));
  });

  it("research (browser): Ba's config keeps only the Chrome plugin: other plugins, his MCP servers, connectors and notify off (PM2 M3)", () => {
    const inv = codex("research", "scan", ["browser@openai-bundled", "superpowers@claude-plugins-official"], ["node_repl", "computer-use", "weird id"]);
    expect(inv.display).toEqual([
      "exec", "--json", "--skip-git-repo-check",
      "-c", 'plugins."browser@openai-bundled".enabled=false',
      "-c", 'plugins."superpowers@claude-plugins-official".enabled=false',
      "-c", "mcp_servers.node_repl.enabled=false",
      "-c", "mcp_servers.computer-use.enabled=false",
      "-c", 'mcp_servers."weird id".enabled=false',
      "-c", "notify=[]",
      "--disable", "apps",
      "--enable", "skip_host_skill_discovery", "--disable", "skill_search",
      "--sandbox", "read-only",
      "-c", 'web_search="live"',
      "--output-schema", `${W}/schema.json`,
      "-o", `${W}/last.json`,
      "<prompt: 6 chars>",
    ]);
    expect(JSON.parse(inv.files[`${W}/schema.json`]!).title).toBe("ResearchScanOutput");
  });

  it("a browser bot's own MCP server is never switched off, even when Ba's config has one of the same name", () => {
    const research = bot("research");
    const def = { ...research, mcpServers: ["orchestrator"], allowedTools: [...research.allowedTools, "mcp:orchestrator:get_status"] };
    const inv = buildCodexInvocation({
      bot: def, plan: planTools(def), prompt: "P", schema: getBotOutputJsonSchema("ResearchScanOutput"), workDir: W, config: CONFIG,
      pluginsToDisable: [], mcpServersToDisable: ["orchestrator", "node_repl"],
    });
    expect(inv.args).toContain("mcp_servers.node_repl.enabled=false");
    expect(inv.args).not.toContain("mcp_servers.orchestrator.enabled=false");
    expect(inv.args).toContain('mcp_servers.orchestrator.url="http://127.0.0.1:4100/mcp"');
  });

  it("non-browser bots ignore the user config altogether: no per-server switches needed", () => {
    const inv = codex("qa", "review", ["browser@openai-bundled"], ["node_repl"]);
    expect(inv.args).toContain("--ignore-user-config");
    expect(inv.args.join(" ")).not.toMatch(/node_repl|notify|plugins\./);
  });

  it("MCP servers via -c with approval mode and an enabled_tools allowlist", () => {
    const def = { ...bot("cv"), engine: "codex" as const };
    const inv = buildCodexInvocation({
      bot: def, plan: planTools(def), prompt: "P", schema: getBotOutputJsonSchema("CvOutput"), workDir: W,
      config: resolveRunnerConfig({ mcpServers: { figma: { command: "npx", args: ["-y", "figma-console-mcp@1.40.9"], env: { FIGMA_MODE: "desktop" } } } }, { HOME: "/h" }),
      pluginsToDisable: [],
      mcpServersToDisable: [],
    });
    const i = inv.args.indexOf("-o") + 2;
    expect(inv.args.slice(i, -1)).toEqual([
      "-c", 'mcp_servers.figma.command="npx"',
      "-c", 'mcp_servers.figma.args=["-y","figma-console-mcp@1.40.9"]',
      "-c", 'mcp_servers.figma.env.FIGMA_MODE="desktop"',
      "-c", 'mcp_servers.figma.default_tools_approval_mode="approve"',
      "-c", 'mcp_servers.figma.enabled_tools=["figma_get_status","figma_execute","figma_capture_screenshot"]',
    ]);
  });

  it("CV on Codex (Ba's opt-in, owner decision 2026-10-11): the pinned figma-console-mcp like Claude's config, 3 tools, read-only, no model", () => {
    const def = { ...bot("cv"), engine: "codex" as const };
    const figma = DEFAULT_MCP_SERVERS.figma as { command: string; args: string[] };
    const inv = buildCodexInvocation({
      bot: def, plan: planTools(def), prompt: "P", schema: getBotOutputJsonSchema("CvOutput"), workDir: W, config: CONFIG,
      pluginsToDisable: ["browser@openai-bundled"], mcpServersToDisable: ["node_repl"],
    });
    expect(inv.display).toEqual([
      "exec", "--json", "--skip-git-repo-check",
      "--ignore-user-config", "--disable", "apps",
      "--sandbox", "read-only", "-c", 'web_search="disabled"',
      "--output-schema", `${W}/schema.json`, "-o", `${W}/last.json`,
      "-c", `mcp_servers.figma.command=${JSON.stringify(figma.command)}`,
      "-c", `mcp_servers.figma.args=${JSON.stringify(figma.args)}`,
      "-c", 'mcp_servers.figma.default_tools_approval_mode="approve"',
      "-c", 'mcp_servers.figma.enabled_tools=["figma_get_status","figma_execute","figma_capture_screenshot"]',
      "<prompt: 1 chars>",
    ]);
    expect(def.model).toBe("sonnet");
  });

  it("never bypasses the sandbox or approvals", () => {
    for (const args of [codex("qa", "review").args, codex("research", "fit").args]) {
      expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(args).not.toContain("--approve-for-me");
      expect(args).toContain("--json");
    }
  });

  it("repair: exec resume on the same thread, user config and every tool off, read-only", () => {
    const inv = buildCodexRepairInvocation({ bot: bot("qa"), prompt: "FIX", threadId: "01a126dc-e579-7312-bbc9-91947b7f50d5", workDir: W, config: CONFIG });
    expect(inv.display).toEqual([
      "exec", "resume", "--json", "--skip-git-repo-check",
      "--ignore-user-config", "--disable", "apps",
      "-c", 'web_search="disabled"',
      "-c", 'sandbox_mode="read-only"',
      "--output-schema", `${W}/schema.json`,
      "-o", `${W}/repair.json`,
      "01a126dc-e579-7312-bbc9-91947b7f50d5",
      "<prompt: 3 chars>",
    ]);
  });
});
