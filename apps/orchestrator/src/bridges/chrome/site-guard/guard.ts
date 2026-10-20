// Site guard for Claude in Chrome tool calls (spec §4.4, §10.2 rule 7; spike S2).
import { isRecord, type GuardDecision, type PreToolUseCall } from "../../hooks/protocol.js";
import { InvalidAllowlistError, normalizeAllowlist } from "./allowlist.js";
import { checkPageJavascript } from "./javascript.js";
import { checkNavigateUrl } from "./url.js";

export const CHROME_TOOL_PREFIX = "mcp__claude-in-chrome__";

/**
 * Tools the hook must see. `navigate` and `javascript_tool` reach other sites directly;
 * `browser_batch` runs both inside one call; `shortcuts_execute` runs saved extension
 * workflows; `switch_browser`/`select_browser` move the session to another browser (select_browser
 * is allowed only for the deviceId Ba chose for bots, live 2026-10-20; switch_browser never).
 * `tabs_create_mcp` is deliberately absent: it opens a blank tab, and blocking it stops the bot.
 * PM2 S7: `computer` is checked for `save_to_disk` (a screenshot written outside data/ whose path
 * the model would repeat); the runner keeps screenshots itself.
 */
export const SITE_GUARD_TOOLS = [
  "navigate",
  "javascript_tool",
  "browser_batch",
  "shortcuts_execute",
  "switch_browser",
  "select_browser",
  "computer",
] as const;

/** A truthy flag as a model might send it: true, "true", 1. */
const truthy = (v: unknown): boolean => v === true || v === 1 || (typeof v === "string" && /^(?:true|1|yes)$/i.test(v.trim()));

export interface SiteGuardPolicy {
  /** Allowed domains; subdomains match. Fixed per spawn (Apply: the approval's domains). */
  allowedSites: readonly string[];
  /** MCP tool name prefix of Claude in Chrome. */
  toolPrefix?: string;
  /** The deviceId Ba chose for bots (Bots screen): the only browser select_browser may select. */
  browserId?: string;
}

function evaluateTool(name: string, input: Record<string, unknown>, sites: readonly string[], inBatch: boolean, browserId?: string): GuardDecision {
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
    case "select_browser":
      // The model never chooses a browser: only the one Ba chose for bots may be selected.
      if (browserId && !inBatch && input.deviceId === browserId) return { allow: true };
      return {
        allow: false,
        rule: "chrome_switch_browser",
        reason: browserId
          ? `Blocked by site guard: select only the browser Ba chose for bots (deviceId ${browserId}).`
          : "Blocked by site guard: bots work only in the browser they were started with.",
      };
    case "switch_browser":
      return {
        allow: false,
        rule: "chrome_switch_browser",
        reason: "Blocked by site guard: bots work only in the browser they were started with.",
      };
    case "computer":
      return truthy(input.save_to_disk)
        ? {
            allow: false,
            rule: "screenshot_save_to_disk",
            reason: "Blocked by site guard: do not save screenshots to disk. Take the screenshot without save_to_disk and name it by the ID the tool shows.",
          }
        : { allow: true };
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
  return evaluateTool(call.toolName.slice(prefix.length), call.toolInput, sites, false, policy.browserId);
}
