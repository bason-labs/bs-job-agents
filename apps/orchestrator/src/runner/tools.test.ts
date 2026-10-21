import { describe, expect, it } from "vitest";
import { BotDefinitionSchema, type BotDefinitionInput } from "@bs-job-agents/shared";
import { CLAUDE_CHROME_TOOLS, ToolConfigError, claudeToolFlags, codexToolConfig, conversationPlan, planTools } from "./tools.js";

const bot = (over: Partial<BotDefinitionInput>) =>
  BotDefinitionSchema.parse({
    name: "scout",
    displayName: "Scout",
    role: "Test bot.",
    engine: "claude",
    model: null,
    trustLevel: 2,
    outputSchema: "ConsultOutput",
    selfCheck: ["ok"],
    promptVersion: 1,
    ...over,
  });

const chrome = (t: string) => `mcp__claude-in-chrome__${t}`;

describe("planTools: the abstract tool vocabulary in bot.json", () => {
  it("parses read, web_search, skills, chrome and MCP tools", () => {
    const plan = planTools(
      bot({
        allowedTools: ["Read", "web_search", "skill:source-*", "chrome:read", "mcp:figma:figma_execute", "mcp:orchestrator:*"],
        browser: { mode: "read", allowedSites: ["topcv.vn"] },
        mcpServers: ["figma", "orchestrator"],
      }),
    );
    expect(plan).toEqual({
      read: true,
      webSearch: true,
      skills: ["source-*"],
      chrome: "read",
      mcp: [
        { server: "figma", tools: ["figma_execute"] },
        { server: "orchestrator", tools: "*" },
      ],
    });
  });

  it.each([
    ["an unknown tool", { allowedTools: ["shell"] }, /unknown tool "shell"/],
    ["a raw Claude permission rule", { allowedTools: ["Read(/tmp/**)"] }, /unknown tool/],
    ["an MCP tool of a server the bot does not have", { allowedTools: ["mcp:figma:figma_execute"] }, /not in mcpServers/],
    ["an MCP server with no allowed tool", { allowedTools: [], mcpServers: ["figma"] }, /no allowed tools/],
    ["chrome without a browser block", { allowedTools: ["chrome:read"] }, /browser/],
    ["a browser block without chrome", { allowedTools: [], browser: { mode: "read" as const, allowedSites: ["topcv.vn"] } }, /chrome:read/],
    ["chrome:write on a read-mode browser", { allowedTools: ["chrome:write"], browser: { mode: "read" as const, allowedSites: ["topcv.vn"] } }, /mode/],
    ["a malformed MCP pattern", { allowedTools: ["mcp:figma"], mcpServers: ["figma"] }, /unknown tool/],
  ])("rejects %s", (_label, over, message) => {
    expect(() => planTools(bot(over as Partial<BotDefinitionInput>))).toThrow(ToolConfigError);
    expect(() => planTools(bot(over as Partial<BotDefinitionInput>))).toThrow(message);
  });
});

describe("conversationPlan (UC-25 consult, UC-15 discussion)", () => {
  it("keeps only reading: no browser, MCP (Figma, orchestrator) or web search", () => {
    const plan = planTools(
      bot({
        allowedTools: ["read", "web_search", "skill:source-*", "chrome:write", "mcp:figma:figma_execute"],
        browser: { mode: "write", allowedSites: ["itviec.com"] },
        mcpServers: ["figma"],
      }),
    );
    expect(conversationPlan(plan)).toEqual({ read: true, webSearch: false, skills: ["source-*"], chrome: null, mcp: [] });
  });
});

describe("claudeToolFlags", () => {
  it("live 2026-10-20: a chosen Chrome browser grants select_browser (the guard checks the id); switch_browser stays hidden", () => {
    const plan = planTools(bot({ allowedTools: ["chrome:write"], browser: { mode: "write" as const, allowedSites: [], sitesFromApproval: true } }));
    const without = claudeToolFlags(plan, { readDirs: [], mcpKnownTools: {} });
    expect(without.allowed).not.toContain("mcp__claude-in-chrome__select_browser");
    expect(without.disallowed).toContain("mcp__claude-in-chrome__select_browser");
    const chosen = claudeToolFlags({ ...plan, chromeBrowserId: "3e83d913-aaaa-4bbb-8ccc-1234567890ab" }, { readDirs: [], mcpKnownTools: {} });
    expect(chosen.allowed).toContain("mcp__claude-in-chrome__select_browser");
    expect(chosen.disallowed).not.toContain("mcp__claude-in-chrome__select_browser");
    expect(chosen.disallowed).toContain("mcp__claude-in-chrome__switch_browser");
  });

  it("Lead: no built-ins, only orchestrator tools", () => {
    const plan = planTools(
      bot({ name: "lead", allowedTools: ["mcp:orchestrator:start_workflow", "mcp:orchestrator:get_status"], mcpServers: ["orchestrator"] }),
    );
    expect(claudeToolFlags(plan, { readDirs: [], mcpKnownTools: {} })).toEqual({
      tools: [],
      allowed: ["mcp__orchestrator__start_workflow", "mcp__orchestrator__get_status"],
      disallowed: [],
      chrome: false,
      addDirs: [],
    });
  });

  it("read: the Read built-in, scoped by --add-dir and an absolute Read rule per read dir", () => {
    const plan = planTools(bot({ allowedTools: ["read"] }));
    expect(claudeToolFlags(plan, { readDirs: ["/data/applications/7"], mcpKnownTools: {} })).toEqual({
      tools: ["Read"],
      allowed: ["Read(//data/applications/7/**)"],
      disallowed: [],
      chrome: false,
      addDirs: ["/data/applications/7"],
    });
  });

  it("ignores read dirs for a bot without read (fewer permissions, never more)", () => {
    const plan = planTools(bot({ allowedTools: ["web_search"] }));
    expect(claudeToolFlags(plan, { readDirs: ["/data"], mcpKnownTools: {} })).toMatchObject({
      tools: ["WebSearch"],
      allowed: ["WebSearch"],
      addDirs: [],
    });
  });

  it("skills: Read rules for the bot's skills folder", () => {
    const plan = planTools(bot({ allowedTools: ["skill:source-*"] }));
    expect(claudeToolFlags(plan, { readDirs: [], mcpKnownTools: {} })).toMatchObject({
      tools: ["Read"],
      allowed: ["Read(./skills/source-*)", "Read(./skills/source-*/**)"],
    });
  });

  it("chrome:write (Apply): --chrome, write tools allowed, every other Chrome tool hidden incl. javascript_tool", () => {
    const plan = planTools(
      bot({ name: "apply", trustLevel: 1, allowedTools: ["chrome:write", "read"], browser: { mode: "write", allowedSites: [], sitesFromApproval: true } }),
    );
    const flags = claudeToolFlags(plan, { readDirs: ["/data/applications/7"], mcpKnownTools: {} });
    expect(flags.chrome).toBe(true);
    expect(flags.tools).toEqual(["Read"]);
    expect(flags.allowed).toEqual([
      "Read(//data/applications/7/**)",
      ...["navigate", "get_page_text", "read_page", "find", "tabs_context_mcp", "tabs_create_mcp", "tabs_close_mcp", "computer", "form_input", "file_upload"].map(chrome),
    ]);
    expect(flags.disallowed).toContain(chrome("javascript_tool"));
    expect(flags.disallowed).toContain(chrome("browser_batch"));
    expect(flags.disallowed).toContain(chrome("switch_browser"));
    expect(new Set([...flags.allowed.filter((a) => a.startsWith("mcp__")), ...flags.disallowed])).toEqual(
      new Set(CLAUDE_CHROME_TOOLS.map(chrome)),
    );
    expect(flags.addDirs).toEqual(["/data/applications/7"]);
  });

  it("chrome:read: no clicking, typing or uploading", () => {
    const plan = planTools(bot({ allowedTools: ["chrome:read"], browser: { mode: "read", allowedSites: ["topcv.vn"] } }));
    const flags = claudeToolFlags(plan, { readDirs: [], mcpKnownTools: {} });
    for (const t of ["computer", "form_input", "file_upload", "javascript_tool"]) expect(flags.disallowed).toContain(chrome(t));
    expect(flags.allowed).toContain(chrome("navigate"));
  });

  it("MCP: hides a server's other tools when its tool list is known (figma has 122)", () => {
    const plan = planTools(bot({ allowedTools: ["mcp:figma:figma_execute"], mcpServers: ["figma"] }));
    expect(claudeToolFlags(plan, { readDirs: [], mcpKnownTools: { figma: ["figma_execute", "figma_get_selection", "figma_delete_node"] } })).toMatchObject({
      allowed: ["mcp__figma__figma_execute"],
      disallowed: ["mcp__figma__figma_get_selection", "mcp__figma__figma_delete_node"],
    });
  });
});

describe("codexToolConfig", () => {
  it("non-browser bot: read-only sandbox, search off, MCP allowlists", () => {
    const plan = planTools(bot({ engine: "codex", allowedTools: ["read", "mcp:figma:figma_execute", "mcp:orchestrator:*"], mcpServers: ["figma", "orchestrator"] }));
    expect(codexToolConfig(plan)).toEqual({
      sandbox: "read-only",
      webSearch: "disabled",
      browser: false,
      mcp: [
        { server: "figma", enabledTools: ["figma_execute"] },
        { server: "orchestrator", enabledTools: null },
      ],
    });
  });

  it("Research: live search and the Chrome plugin", () => {
    const plan = planTools(bot({ engine: "codex", allowedTools: ["web_search", "chrome:read", "skill:source-*"], browser: { mode: "read", allowedSites: ["topcv.vn"] } }));
    expect(codexToolConfig(plan)).toEqual({ sandbox: "read-only", webSearch: "live", browser: true, mcp: [] });
  });
});
