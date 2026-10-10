// URL rules of the site guard. Parsing uses the WHATWG URL parser (the one Chrome uses), so
// tricks such as `https://evil\@topcv.vn`, tabs inside `java\tscript:` or IDN look-alikes are
// judged by the host Chrome would actually load.
import type { StaticValue } from "../../js/ast.js";
import type { GuardDecision } from "../../hooks/protocol.js";
import { hostAllowed } from "./allowlist.js";

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;
/** Sentinel origin for resolving relative URLs; never a real site (.invalid is reserved). */
const RELATIVE_BASE = "https://relative.site-guard.invalid/";
const RELATIVE_HOST = "relative.site-guard.invalid";

/** What the WHATWG parser strips before parsing: ASCII tab/newline anywhere, C0 controls and spaces around. */
function preprocess(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\t\n\r]/g, "").replace(/^[\u0000- ]+|[\u0000- ]+$/g, "");
}

export function describeAllowlist(allowlist: readonly string[]): string {
  return allowlist.length > 0 ? allowlist.join(", ") : "none";
}

function hostBlocked(what: string, host: string, allowlist: readonly string[], rule: string): GuardDecision {
  return {
    allow: false,
    rule,
    target: host,
    reason:
      `Blocked by site guard: ${what} goes to "${host}", which is outside this task's allowed sites ` +
      `(${describeAllowlist(allowlist)}). Stay on the allowed sites; if the task needs another site, stop and report it.`,
  };
}

function schemeBlocked(what: string, scheme: string, rule: string): GuardDecision {
  return {
    allow: false,
    rule,
    target: scheme,
    reason: `Blocked by site guard: ${what} uses "${scheme}"; only http and https pages on the allowed sites can be opened.`,
  };
}

function checkParsed(url: URL, what: string, allowlist: readonly string[], rulePrefix: string): GuardDecision {
  if (!ALLOWED_SCHEMES.has(url.protocol)) return schemeBlocked(what, url.protocol, `${rulePrefix}_scheme`);
  if (!hostAllowed(url.hostname, allowlist)) return hostBlocked(what, url.hostname, allowlist, `${rulePrefix}_host`);
  return { allow: true };
}

/**
 * The `navigate` tool: a URL with or without a scheme (Claude in Chrome adds https://), or
 * `back` / `forward`. History moves are allowed: they only revisit pages this tab has shown.
 */
export function checkNavigateUrl(rawUrl: unknown, allowlist: readonly string[]): GuardDecision {
  const what = "navigation";
  if (typeof rawUrl !== "string" || preprocess(rawUrl) === "") {
    return { allow: false, rule: "navigate_url", reason: "Blocked by site guard: navigate needs a URL on an allowed site." };
  }
  const value = preprocess(rawUrl);
  if (/^(back|forward)$/i.test(value)) return { allow: true };

  const scheme = SCHEME_RE.exec(value)?.[1]?.toLowerCase();
  let candidate: string;
  if (scheme !== undefined) {
    // "topcv.vn:443/x" also lands here: a scheme to Chrome, so it is refused rather than guessed.
    if (scheme !== "http" && scheme !== "https") return schemeBlocked(what, `${scheme}:`, "navigate_scheme");
    candidate = value;
  } else if (/^[/\\]{2}/.test(value)) {
    candidate = `https:${value}`;
  } else {
    candidate = `https://${value}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { allow: false, rule: "navigate_url", reason: `Blocked by site guard: "${rawUrl}" is not a valid URL.` };
  }
  return checkParsed(url, what, allowlist, "navigate");
}

function checkExact(value: string, what: string, allowlist: readonly string[]): GuardDecision {
  let url: URL;
  try {
    url = new URL(preprocess(value), RELATIVE_BASE);
  } catch {
    return { allow: false, rule: "js_url", reason: `Blocked by site guard: ${what} uses an invalid URL "${value}".` };
  }
  if (url.protocol === "https:" && url.hostname === RELATIVE_HOST) return { allow: true }; // same origin
  return checkParsed(url, what, allowlist, "js");
}

const TERMINATORS = /[/?#\\]/;

/** A prefix like `https://host/…` or `//host/…` fixes the origin only once the authority has ended. */
function checkPrefix(rawPrefix: string, what: string, allowlist: readonly string[]): GuardDecision {
  const prefix = preprocess(rawPrefix);
  const unknown: GuardDecision = unverifiable(what);
  const scheme = SCHEME_RE.exec(prefix)?.[1]?.toLowerCase();
  let afterSlashes: string;
  let base: string;
  if (scheme !== undefined) {
    if (scheme !== "http" && scheme !== "https") return schemeBlocked(what, `${scheme}:`, "js_scheme");
    const rest = prefix.slice(scheme.length + 1);
    const slashes = /^[/\\]*/.exec(rest)?.[0] ?? "";
    afterSlashes = rest.slice(slashes.length);
    base = `${scheme}://`;
  } else if (/^[/\\]{2}/.test(prefix)) {
    const slashes = /^[/\\]*/.exec(prefix)?.[0] ?? "";
    afterSlashes = prefix.slice(slashes.length);
    base = "https://";
  } else if (/^[/\\][^/\\]/.test(prefix) || /^(\?|#|\.\.?[/\\])/.test(prefix)) {
    return { allow: true }; // a path, query or fragment on the current origin
  } else if (/^[/\\]/.test(prefix)) {
    return unknown; // a lone "/" may still become "//other-host"
  } else {
    // A relative path is safe once something other than a scheme character came before any ':'.
    const firstSpecial = prefix.search(/[^a-z0-9+.-]/i);
    if (firstSpecial >= 0 && prefix[firstSpecial] !== ":") return { allow: true };
    return unknown;
  }
  const end = afterSlashes.search(TERMINATORS);
  if (end < 0) return unknown;
  return checkExact(`${base}${afterSlashes.slice(0, end)}/`, what, allowlist);
}

function unverifiable(what: string): GuardDecision {
  return {
    allow: false,
    rule: "js_unverifiable_url",
    reason:
      `Blocked by site guard: ${what} uses a URL the guard cannot verify. Use a literal URL on an allowed site, ` +
      `or open pages with the navigate tool instead of page code.`,
  };
}

/** A URL value used by page JavaScript (fetch, location, src…). Relative URLs stay on the current origin. */
export function checkPageUrlValue(value: StaticValue | null, allowlist: readonly string[], what = "page code"): GuardDecision {
  if (!value) return unverifiable(what);
  return "exact" in value ? checkExact(value.exact, what, allowlist) : checkPrefix(value.prefix, what, allowlist);
}
