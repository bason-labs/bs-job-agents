// Site guard for Claude in Chrome tool calls (spec §4.4, §10.2 rule 7; spike S2).
import { isRecord, type GuardDecision, type PreToolUseCall } from "../../hooks/protocol.js";
import { InvalidAllowlistError, normalizeAllowlist } from "./allowlist.js";
import { checkPageJavascript } from "./javascript.js";
import { checkNavigateUrl } from "./url.js";

export const CHROME_TOOL_PREFIX = "mcp__claude-in-chrome__";

/**
 * Tools the hook must see. `navigate` and `javascript_tool` reach other sites directly;
 * `browser_batch` runs both inside one call; `shortcuts_execute` runs saved extension
 * workflows; `switch_browser`/`select_browser` move the session to another browser.
 * `tabs_create_mcp` is deliberately absent: it opens a blank tab, and blocking it stops the bot.
 */
export const SITE_GUARD_TOOLS = [
  "navigate",
  "javascript_tool",
  "browser_batch",
  "shortcuts_execute",
  "switch_browser",
  "select_browser",
] as const;

export interface SiteGuardPolicy {
  /** Allowed domains; subdomains match. Fixed per spawn (Apply: the approval's domains). */
  allowedSites: readonly string[];
  /** MCP tool name prefix of Claude in Chrome. */
  toolPrefix?: string;
}

function evaluateTool(name: string, input: Record<string, unknown>, sites: readonly string[], inBatch: boolean): GuardDecision {
  switch (name) {
    case "navigate":
      return checkNavigateUrl(input.url, sites);
    case "javascript_tool":
      return checkPageJavascript(input.text, sites);
    case "browser_batch":
      return inBatch
        ? { allow: false, rule: "batch_nested", reason: "Blocked by site guard: browser_batch cannot be nested." }
        : evaluateBatch(input.actions, sites);
    case "shortcuts_execute":
      return {
        allow: false,
        rule: "chrome_shortcut",
        reason: "Blocked by site guard: extension shortcuts run workflows the guard cannot check. Use navigate and the page tools.",
      };
    case "switch_browser":
    case "select_browser":
      return {
        allow: false,
        rule: "chrome_switch_browser",
        reason: "Blocked by site guard: bots work only in the browser they were started with.",
      };
    default:
      return { allow: true };
  }
}

function evaluateBatch(actions: unknown, sites: readonly string[]): GuardDecision {
  const malformed: GuardDecision = {
    allow: false,
    rule: "batch_malformed",
    reason: "Blocked by site guard: browser_batch needs a list of {name, input} actions.",
  };
  if (!Array.isArray(actions)) return malformed;
  for (const [i, action] of actions.entries()) {
    if (!isRecord(action) || typeof action.name !== "string") return malformed;
    const name = action.name.startsWith(CHROME_TOOL_PREFIX) ? action.name.slice(CHROME_TOOL_PREFIX.length) : action.name;
    const decision = evaluateTool(name, isRecord(action.input) ? action.input : {}, sites, true);
    if (!decision.allow) {
      return { ...decision, reason: decision.reason.replace(/^Blocked by site guard: /, `Blocked by site guard: browser_batch action ${i + 1} (${name}): `) };
    }
  }
  return { allow: true };
}

export function evaluateChromeToolCall(call: Pick<PreToolUseCall, "toolName" | "toolInput">, policy: SiteGuardPolicy): GuardDecision {
  const prefix = policy.toolPrefix ?? CHROME_TOOL_PREFIX;
  if (!call.toolName.startsWith(prefix)) return { allow: true };
  let sites: string[];
  try {
    sites = normalizeAllowlist(policy.allowedSites);
  } catch (err) {
    if (!(err instanceof InvalidAllowlistError)) throw err;
    return { allow: false, rule: "guard_config", reason: `Blocked by site guard: the allowed-site list is invalid (${err.message}).` };
  }
  return evaluateTool(call.toolName.slice(prefix.length), call.toolInput, sites, false);
}
