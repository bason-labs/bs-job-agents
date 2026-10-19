// Text hygiene shared by the screens that keep model-written text out of later prompts: memory
// notes (PM2 S14, orchestrator runner/memory-hygiene.ts) and drafted source skills (sub-project 4,
// skills/screen.ts). Pure, no I/O.
import { isPublicHost, normalizeHostName } from "./host.js";

/** Keys, tokens, passwords and cookies by their shape or their label. */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:api[_ -]?key|secret|token|password|passwd|pwd|passcode|cookie|session[_ -]?id|bearer|authorization|otp|pin)\b\s*[:=]\s*\S+/i,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/-]{12,}=*/i,
  /\b(?:cookie|set-cookie)\b.{0,20}[A-Za-z0-9_-]{16,}/i,
];

/** A run of 32+ key-like characters with both letters and digits (keys, tokens, hashes). */
export function hasOpaqueSecret(text: string): boolean {
  for (const m of text.matchAll(/[A-Za-z0-9+/_=-]{32,}/g)) {
    const t = m[0];
    if (/[A-Za-z]/.test(t) && /\d/.test(t)) return true;
  }
  return false;
}

/**
 * The stricter-shaped variant for longer documents that quote URL paths ("/tim-viec-lam-software-
 * engineering-cr257cb258"): a run of 24+ characters with no slash or hyphen that mixes letters and
 * digits, or 32+ hex digits.
 */
export function hasOpaqueToken(text: string): boolean {
  for (const m of text.matchAll(/[A-Za-z0-9+_=]{24,}/g)) {
    const t = m[0];
    if (/[A-Za-z]/.test(t) && /\d/.test(t)) return true;
  }
  return /\b[0-9a-f]{32,}\b/i.test(text);
}

/** Extensions that look like top-level domains in "memory.md", "run.sh", "cv.zip". */
export const FILE_EXTENSIONS: ReadonlySet<string> = new Set(["md", "pdf", "json", "yaml", "yml", "txt", "png", "jpg", "jpeg", "gif", "js", "ts", "tsx", "html", "htm", "css", "csv", "doc", "docx", "py", "sh", "zip", "xml", "svg", "fig", "log"]);

/** Hosts a text names: every URL's host, IPv4 addresses, localhost, and bare names under a public suffix. */
export function hostsInText(text: string): string[] {
  const hosts = new Set<string>();
  for (const m of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/([^\s/?#:'"<>)`]+)/gi)) hosts.add(normalizeHostName(m[1]!.replace(/^[^@]*@/, "")));
  for (const m of text.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)) hosts.add(m[0]);
  for (const m of text.matchAll(/\blocalhost\b/gi)) hosts.add(m[0].toLowerCase());
  for (const m of text.matchAll(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]\b/gi)) {
    const host = normalizeHostName(m[0]);
    const last = host.split(".").at(-1)!;
    const scheme = text.slice(Math.max(0, m.index - 3), m.index) === "://";
    if (!scheme && FILE_EXTENSIONS.has(last) && !host.startsWith("www.")) continue;
    if (isPublicHost(host)) hosts.add(host);
  }
  return [...hosts];
}

/** `host` is one of `sites` or a subdomain of one. */
export function hostWithin(host: string, sites: readonly string[]): boolean {
  const h = normalizeHostName(host);
  return sites.some((s) => {
    const site = normalizeHostName(s);
    return site !== "" && (h === site || h.endsWith(`.${site}`));
  });
}
