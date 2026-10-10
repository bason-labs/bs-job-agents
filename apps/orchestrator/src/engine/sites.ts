// Sites in the engine's site-guard decisions (PM2 M2, S3): hosts are compared lowercase, without a
// trailing dot or a leading www.; the site guard's blocks come from its log (or the runner's hook
// denials when the log is empty); a site a bot names in its own pause is reduced to a plain host.
import { normalizeHostName } from "@bs-job-agents/shared";
import { CHROME_TOOL_PREFIX } from "../bridges/chrome/site-guard/guard.js";
import type { RunnerResult } from "../runner/types.js";
import type { GuardBlock } from "./ports.js";

/** One Chrome call the site guard blocked in this attempt, and the host it was going to (if it was one). */
export interface SiteBlock {
  tool: string;
  host: string | null;
}

const HOST_RE = /^[a-z0-9.-]+$/;

/** A host as the engine compares hosts: lowercase, no trailing dot, no leading www. */
export function siteKey(host: string): string {
  return normalizeHostName(host).replace(/^www\./, "");
}

/** The host of a navigate target (with or without a scheme), or null. */
export function hostOfUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const raw = value.trim();
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw.replace(/^\/\//, "")}`);
    const host = normalizeHostName(url.hostname);
    return HOST_RE.test(host) ? host : null;
  } catch {
    return null;
  }
}

/**
 * The site guard's blocks in this attempt (§10.2 rule 7): the guard log's `site` lines; when the log
 * holds nothing, the runner's hook denials of Chrome tools (the same blocks, as the CLI reported them).
 */
export function siteBlocksOf(log: readonly GuardBlock[], result: RunnerResult): SiteBlock[] {
  if (log.length > 0) {
    return log.filter((b) => b.guard === "site").map((b) => ({ tool: b.tool, host: b.target && HOST_RE.test(normalizeHostName(b.target)) ? normalizeHostName(b.target) : null }));
  }
  if (result.status !== "denied") return [];
  return result.denials
    .filter((d) => d.source === "hook" && d.tool.startsWith(CHROME_TOOL_PREFIX))
    .map((d) => ({ tool: d.tool, host: hostOfUrl((d.input as { url?: unknown } | null)?.url) }));
}

/**
 * A site a bot named in its own pause (needs_login, captcha), as a plain host: a URL or odd
 * characters never reach the stored pause reason (`code(site)`), which must parse back.
 */
export function pauseSite(raw: string | null | undefined, fallback: string | null): string | null {
  const host = raw ? (hostOfUrl(raw) ?? null) : null;
  return host ?? fallback;
}
