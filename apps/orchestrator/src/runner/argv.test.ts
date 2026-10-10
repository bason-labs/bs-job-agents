// Golden argv per bot (spike S1/S2/S4 flags), built from the real bots/<name>/bot.json.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getBotOutputJsonSchema, resolveOutputSchemaName, type BotDefinition } from "@bs-job-agents/shared";
import { loadBotDefinition } from "./bots.js";
import { buildClaudeInvocation, buildClaudeRepairInvocation, claudeSettings } from "./claude/argv.js";
import { buildCodexInvocation, buildCodexRepairInvocation } from "./codex/argv.js";
import { RunnerConfigError } from "./errors.js";
import { defaultBotsDir, resolveRunnerConfig, type RunnerConfig } from "./config.js";
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
    hooks: {
      siteGuard: { command: "node", args: ["/repo/apps/orchestrator/dist/bridges/site-guard-hook.js"] },
      figmaGuard: { command: "node", args: ["/repo/apps/orchestrator/dist/bridges/figma-guard-hook.js"] },
    },
  },
  { HOME: "/Users/ba" },
);

function claude(name: string, kind: string, extra: { readDirs?: string[]; allowedSites?: string[] } = {}) {
  const def = bot(name);
  return buildClaudeInvocation({
    bot: def,
    plan: planTools(def),
    prompt: "PROMPT",
    schema: getBotOutputJsonSchema(resolveOutputSchemaName(def, kind)),
    sessionId: SID,
    workDir: W,
    readDirs: extra.readDirs ?? [],
    allowedSites: extra.allowedSites ?? [],
    config: CONFIG,
  });
}

function codex(name: string, kind: string, plugins: string[] = []) {
  const def = bot(name);
  return buildCodexInvocation({
    bot: def,
    plan: planTools(def),
    prompt: "PROMPT",
    schema: getBotOutputJsonSchema(resolveOutputSchemaName(def, kind)),
    workDir: W,
    config: CONFIG,
    pluginsToDisable: plugins,
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
    ]);
    expect(JSON.parse(inv.files[`${W}/mcp.json`]!)).toEqual({ mcpServers: { orchestrator: { type: "http", url: "http://127.0.0.1:4100/mcp" } } });
  });

  it("cv", () => {
    const inv = claude("cv", "tailor", { readDirs: ["/repo/data/master"] });
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
      "--mcp-config", `${W}/mcp.json`,
      "--strict-mcp-config",
      "--settings",
      '{"autoMemoryEnabled":false,"hooks":{"PreToolUse":[{"matcher":"mcp__figma__figma_execute","hooks":[{"type":"command","command":"node /repo/apps/orchestrator/dist/bridges/figma-guard-hook.js"}]}]}}',
      "--json-schema", "<schema: CvOutput>",
      "--session-id", SID,
      "--permission-prompts", "none",
      "--add-dir", "/repo/data/master",
    ]);
    expect(JSON.parse(inv.files[`${W}/mcp.json`]!)).toEqual({
      mcpServers: { figma: { type: "stdio", command: "npx", args: ["-y", "figma-console-mcp@1.40.9"] } },
    });
  });

  it("apply", () => {
    const inv = claude("apply", "submit", { readDirs: ["/repo/data/applications/7"], allowedSites: ["itviec.com"] });
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
      '{"autoMemoryEnabled":false,"hooks":{"PreToolUse":[{"matcher":"mcp__claude-in-chrome__navigate|mcp__claude-in-chrome__javascript_tool","hooks":[{"type":"command","command":"node /repo/apps/orchestrator/dist/bridges/site-guard-hook.js --sites itviec.com"}]}]}}',
      "--json-schema", "<schema: ApplyOutput>",
      "--session-id", SID,
      "--permission-prompts", "none",
      "--chrome",
      "--add-dir", "/repo/data/applications/7",
    ]);
    expect(inv.files).toEqual({});
  });

  it("passes the prompt and the strict schema verbatim", () => {
    const inv = claude("cv", "tailor");
    expect(inv.args[1]).toBe("PROMPT");
    expect(JSON.parse(inv.args[inv.args.indexOf("--json-schema") + 1]!)).toEqual(getBotOutputJsonSchema("CvOutput"));
  });

  it("adds --model only when bot.json sets one", () => {
    const def = { ...bot("qa"), engine: "claude" as const, model: "haiku" };
    const inv = buildClaudeInvocation({
      bot: def, plan: planTools(def), prompt: "P", schema: getBotOutputJsonSchema("QaOutput"),
      sessionId: SID, workDir: W, readDirs: [], allowedSites: [], config: CONFIG,
    });
    expect(inv.args.slice(inv.args.indexOf("--model"), inv.args.indexOf("--model") + 2)).toEqual(["--model", "haiku"]);
  });

  it("never uses the flags the spike ruled out", () => {
    for (const [name, kind] of [["lead", "chat"], ["cv", "tailor"], ["apply", "submit"]] as const) {
      const args = claude(name, kind, { allowedSites: ["itviec.com"] }).args;
      for (const banned of ["--bare", "--safe-mode", "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions"]) {
        expect(args, `${name} ${banned}`).not.toContain(banned);
      }
      expect(args).toContain("--strict-mcp-config");
    }
  });

  it("refuses a browser bot without the site guard, a Figma bot without the Figma guard, or an unknown MCP server", () => {
    const noHooks = resolveRunnerConfig({ hooks: {} }, { HOME: "/Users/ba" });
    const apply = bot("apply");
    expect(() => claudeSettings({ plan: planTools(apply), allowedSites: ["itviec.com"], config: noHooks })).toThrow(/site guard/);
    const cv = bot("cv");
    expect(() => claudeSettings({ plan: planTools(cv), allowedSites: [], config: noHooks })).toThrow(/Figma guard/);
    const lead = bot("lead");
    expect(() =>
      buildClaudeInvocation({
        bot: lead, plan: planTools(lead), prompt: "P", schema: getBotOutputJsonSchema("LeadOutput"),
        sessionId: SID, workDir: W, readDirs: [], allowedSites: [], config: noHooks,
      }),
    ).toThrow(RunnerConfigError);
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

  it("research (browser): Ba's config with every other plugin off, host skills skipped, live search", () => {
    const inv = codex("research", "scan", ["browser@openai-bundled", "superpowers@claude-plugins-official"]);
    expect(inv.display).toEqual([
      "exec", "--json", "--skip-git-repo-check",
      "-c", 'plugins."browser@openai-bundled".enabled=false',
      "-c", 'plugins."superpowers@claude-plugins-official".enabled=false',
      "--enable", "skip_host_skill_discovery", "--disable", "skill_search",
      "--sandbox", "read-only",
      "-c", 'web_search="live"',
      "--output-schema", `${W}/schema.json`,
      "-o", `${W}/last.json`,
      "<prompt: 6 chars>",
    ]);
    expect(JSON.parse(inv.files[`${W}/schema.json`]!).title).toBe("ResearchScanOutput");
  });

  it("MCP servers via -c with approval mode and an enabled_tools allowlist", () => {
    const def = { ...bot("cv"), engine: "codex" as const };
    const inv = buildCodexInvocation({
      bot: def, plan: planTools(def), prompt: "P", schema: getBotOutputJsonSchema("CvOutput"), workDir: W,
      config: resolveRunnerConfig({ mcpServers: { figma: { command: "npx", args: ["-y", "figma-console-mcp@1.40.9"], env: { FIGMA_MODE: "desktop" } } } }, { HOME: "/h" }),
      pluginsToDisable: [],
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
