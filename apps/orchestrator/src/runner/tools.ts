// The abstract tool vocabulary of bot.json `allowedTools` (§5.1) and its mapping per engine.
//
//   read              Read files in the bot folder and the task's readDirs.
//                     Claude: built-in Read; each read dir gets --add-dir and Read(//<dir>/**).
//                     Codex: the read-only sandbox (it cannot scope reads; prompt only).
//   web_search        Claude: WebSearch. Codex: -c web_search="live" (verified live).
//   skill:<glob>      Read the bot's skills/<glob> files (source adapters, W4a).
//   chrome:read       Ba's Chrome, read only (navigate, read, find, tabs). Needs browser.mode read.
//   chrome:write      Full interaction for Apply: also click/type (computer), form_input, file_upload.
//                     javascript_tool is never allowed (§4.4). Needs browser.mode write.
//   mcp:<srv>:<tool>  One tool of an MCP server listed in mcpServers; mcp:<srv>:* = all its tools.
//
// Anything else is an error when the bot is loaded, so a typo never grants or silently drops a tool.
import type { BotDefinition } from "@bs-job-agents/shared";

export class ToolConfigError extends Error {
  constructor(bot: string, message: string) {
    super(`bot ${bot}: ${message}`);
    this.name = "ToolConfigError";
  }
}

export interface McpToolPlan {
  server: string;
  /** "*" = every tool of the server. */
  tools: string[] | "*";
}

export interface ToolPlan {
  read: boolean;
  webSearch: boolean;
  skills: string[];
  chrome: "read" | "write" | null;
  mcp: McpToolPlan[];
}

/** The Claude in Chrome tools, as listed by `claude -p --chrome` 2.1.296 (fixture claude/chrome-init.jsonl). */
export const CLAUDE_CHROME_SERVER = "claude-in-chrome";
export const CLAUDE_CHROME_TOOLS = [
  "browser_batch",
  "computer",
  "file_upload",
  "find",
  "form_input",
  "get_page_text",
  "gif_creator",
  "javascript_tool",
  "list_connected_browsers",
  "navigate",
  "read_console_messages",
  "read_network_requests",
  "read_page",
  "resize_window",
  "select_browser",
  "shortcuts_execute",
  "shortcuts_list",
  "switch_browser",
  "tabs_close_mcp",
  "tabs_context_mcp",
  "tabs_create_mcp",
  "upload_image",
] as const;
type ChromeTool = (typeof CLAUDE_CHROME_TOOLS)[number];

/** Read mode: navigate, read and find; tab tools so the bot can open and close its own tab. */
export const CHROME_READ_TOOLS: readonly ChromeTool[] = [
  "navigate",
  "get_page_text",
  "read_page",
  "find",
  "tabs_context_mcp",
  "tabs_create_mcp",
  "tabs_close_mcp",
];
/** Write mode (Apply): plus clicks/typing/screenshots (computer), form fields and the PDF upload. */
export const CHROME_WRITE_TOOLS: readonly ChromeTool[] = [...CHROME_READ_TOOLS, "computer", "form_input", "file_upload"];

export const chromeToolName = (tool: string): string => `mcp__${CLAUDE_CHROME_SERVER}__${tool}`;
export const mcpToolName = (server: string, tool: string): string => `mcp__${server}__${tool}`;

const MCP_PATTERN = /^mcp:([a-z0-9][a-z0-9_-]*):([A-Za-z0-9_.*-]+)$/;
const SKILL_PATTERN = /^skill:([A-Za-z0-9_.*-]+)$/;

/** Parse and check `allowedTools` against the rest of the definition. Throws ToolConfigError. */
export function planTools(def: Pick<BotDefinition, "name" | "allowedTools" | "browser" | "mcpServers">): ToolPlan {
  const plan: ToolPlan = { read: false, webSearch: false, skills: [], chrome: null, mcp: [] };
  const mcp = new Map<string, string[] | "*">();
  for (const raw of def.allowedTools) {
    const token = raw.trim();
    if (token.toLowerCase() === "read") plan.read = true;
    else if (token === "web_search") plan.webSearch = true;
    else if (token === "chrome:read" || token === "chrome:write") {
      const mode = token === "chrome:write" ? "write" : "read";
      if (plan.chrome !== "write") plan.chrome = mode;
    } else if (SKILL_PATTERN.test(token)) plan.skills.push(SKILL_PATTERN.exec(token)![1]!);
    else if (MCP_PATTERN.test(token)) {
      const [, server = "", tool = ""] = MCP_PATTERN.exec(token)!;
      if (!def.mcpServers.includes(server)) throw new ToolConfigError(def.name, `"${token}": server ${server} is not in mcpServers`);
      const current = mcp.get(server);
      if (tool === "*") mcp.set(server, "*");
      else if (current !== "*") mcp.set(server, [...(current ?? []), tool]);
    } else {
      throw new ToolConfigError(def.name, `unknown tool "${token}" (use read, web_search, skill:<glob>, chrome:read, chrome:write or mcp:<server>:<tool>)`);
    }
  }
  for (const server of def.mcpServers) {
    const tools = mcp.get(server);
    if (!tools) throw new ToolConfigError(def.name, `MCP server ${server} has no allowed tools (add mcp:${server}:<tool>)`);
    plan.mcp.push({ server, tools });
  }
  if (plan.chrome && !def.browser) throw new ToolConfigError(def.name, `chrome:${plan.chrome} needs a browser block with mode and allowedSites`);
  if (def.browser && !plan.chrome) throw new ToolConfigError(def.name, "a browser block needs chrome:read or chrome:write in allowedTools");
  if (def.browser && plan.chrome === "write" && def.browser.mode !== "write") {
    throw new ToolConfigError(def.name, "chrome:write needs browser mode write");
  }
  return plan;
}

export interface ClaudeToolFlags {
  /** --tools: built-in tools ("" when empty). StructuredOutput is added by the CLI. */
  tools: string[];
  /** --allowedTools: runs without asking; anything else is auto-denied (--permission-prompts none). */
  allowed: string[];
  /** --disallowedTools: hidden from the model, so it never tries them (verified with --chrome). */
  disallowed: string[];
  chrome: boolean;
  addDirs: string[];
}

export interface ClaudeToolContext {
  readDirs: readonly string[];
  /** Known tool names per MCP server; when given, tools the bot may not use are hidden. */
  mcpKnownTools: Record<string, readonly string[] | undefined>;
}

export function claudeToolFlags(plan: ToolPlan, ctx: ClaudeToolContext): ClaudeToolFlags {
  const tools = new Set<string>();
  const allowed: string[] = [];
  const disallowed: string[] = [];
  if (plan.webSearch) {
    tools.add("WebSearch");
    allowed.push("WebSearch");
  }
  for (const glob of plan.skills) {
    tools.add("Read");
    allowed.push(`Read(./skills/${glob})`, `Read(./skills/${glob}/**)`);
  }
  // Read dirs are granted only to bots that may read (Apply uploads the approved PDF from one).
  const addDirs = plan.read ? [...ctx.readDirs] : [];
  if (plan.read) tools.add("Read");
  for (const dir of addDirs) allowed.push(`Read(/${dir}/**)`);
  if (plan.chrome) {
    const ok = new Set<string>(plan.chrome === "write" ? CHROME_WRITE_TOOLS : CHROME_READ_TOOLS);
    for (const t of plan.chrome === "write" ? CHROME_WRITE_TOOLS : CHROME_READ_TOOLS) allowed.push(chromeToolName(t));
    for (const t of CLAUDE_CHROME_TOOLS) if (!ok.has(t)) disallowed.push(chromeToolName(t));
  }
  for (const { server, tools: list } of plan.mcp) {
    if (list === "*") {
      allowed.push(`mcp__${server}`);
      continue;
    }
    for (const t of list) allowed.push(mcpToolName(server, t));
    for (const t of ctx.mcpKnownTools[server] ?? []) if (!list.includes(t)) disallowed.push(mcpToolName(server, t));
  }
  return { tools: [...tools].sort(), allowed, disallowed, chrome: plan.chrome !== null, addDirs };
}

export interface CodexToolConfig {
  sandbox: "read-only";
  webSearch: "live" | "disabled";
  /** Browser bots load Ba's user config for the Chrome plugin (§4.4). */
  browser: boolean;
  /** enabled_tools per server (null = all); tools outside the list are not offered (verified live). */
  mcp: Array<{ server: string; enabledTools: string[] | null }>;
}

export function codexToolConfig(plan: ToolPlan): CodexToolConfig {
  return {
    sandbox: "read-only",
    webSearch: plan.webSearch ? "live" : "disabled",
    browser: plan.chrome !== null,
    mcp: plan.mcp.map(({ server, tools }) => ({ server, enabledTools: tools === "*" ? null : [...tools] })),
  };
}
