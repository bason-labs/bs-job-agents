// Site allowlists (spec §4.4, §10.2 rule 7): a host is allowed when it is a listed domain or a
// subdomain of one. Parents and look-alikes are not (same rule as the approval domains, PM §7).
// PM2 M2: every entry must pass the shared public-host rule (no public suffix such as vn or
// github.io, no IP address, localhost or local name), so an entry only ever widens to its own
// subdomains. The hook process loads only that rule (`@bs-job-agents/shared/host`), not all of shared.
import { publicHostProblem } from "@bs-job-agents/shared/host";

export class InvalidAllowlistError extends Error {
  override readonly name = "InvalidAllowlistError";
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9-]+\.)*[a-z0-9-]+$/;

function toAsciiHost(entry: string): string | null {
  try {
    const url = new URL(`https://${entry}/`);
    // Anything that changes the path, adds a port or credentials is not a bare host name.
    if (url.pathname !== "/" || url.port || url.username || url.password || url.search || url.hash) return null;
    return url.hostname;
  } catch {
    return null;
  }
}

/** Normalises and validates allowlist entries (`topcv.vn`, `*.itviec.com`): public web sites only. Throws on anything else. */
export function normalizeAllowlist(entries: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of entries) {
    let entry = raw.trim().toLowerCase().replace(/^\*\./, "").replace(/^\.+/, "").replace(/\.+$/, "");
    if (entry === "" || /[\s/:@\\?#*]/.test(entry)) throw new InvalidAllowlistError(`not a host name: "${raw}"`);
    const ascii = toAsciiHost(entry);
    if (!ascii || !HOST_RE.test(ascii)) throw new InvalidAllowlistError(`not a host name: "${raw}"`);
    const problem = publicHostProblem(ascii);
    if (problem) throw new InvalidAllowlistError(`not a public web site: "${raw}" (${problem})`);
    entry = ascii;
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

/** Normalises a URL host for matching: lowercase, no trailing dot. */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, "");
}

export function hostAllowed(host: string, allowlist: readonly string[]): boolean {
  const h = normalizeHost(host);
  if (h === "") return false;
  return allowlist.some((d) => h === d || h.endsWith(`.${d}`));
}
