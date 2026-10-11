// PM2 M2: the one public-host rule for allowlists and approval domains (§10.2 rules 2 and 7).
// A host a bot may be sent to in Ba's Chrome must be a public web site with a registrable name:
// never a public suffix ("com", "com.vn", "github.io"), a single label, an IP address (so no
// private range or loopback), localhost, or a local or reserved name (*.local, *.home.arpa, *.test…).
// Matching with subdomains (`hostAllowed`) is then safe: an entry can only widen to its own subdomains.
// The Public Suffix List comes from tldts (pinned), with its private section (github.io, …).
import { parse } from "tldts";

/** Names that only exist on Ba's Mac or LAN, or are reserved (RFC 6761, 6762, 8375, ICANN .internal). */
const LOCAL_NAMES = ["localhost", "local", "localdomain", "test", "invalid", "example", "onion", "arpa", "internal", "lan", "home", "corp", "intranet", "private"];

/**
 * Public names known to resolve to Ba's machine or LAN: wildcard IP DNS services and router admin
 * pages. Not complete (any name can point anywhere); defence in depth for allowlists and domain_confirm.
 */
const LOCAL_ALIASES = ["nip.io", "sslip.io", "xip.io", "localtest.me", "lvh.me", "vcap.me", "traefik.me", "lacolhost.com", "fritz.box", "router.asus.com", "routerlogin.net", "routerlogin.com", "tplinkwifi.net", "tplinklogin.net", "mywifiext.net"];

/** Lowercase, trimmed, without trailing dots: how hosts are compared everywhere. */
export function normalizeHostName(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, "");
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Why `host` is not a public web site's name, or null when it is one. */
export function publicHostProblem(raw: string): string | null {
  const host = normalizeHostName(raw);
  if (host === "") return "the host name is empty";
  if (host.length > 253 || !host.split(".").every((label) => LABEL.test(label))) {
    return `"${raw}" is not a host name such as topcv.vn`;
  }
  const labels = host.split(".");
  const last = labels.at(-1)!;
  // A numeric last label is an IPv4 address to a browser (127.1, 2130706433, 0x7f.0.0.1).
  if (/^(?:\d+|0x[0-9a-f]*)$/.test(last)) return `${host} is an IP address, not a public web site`;
  const local = LOCAL_NAMES.find((name) => host === name || host.endsWith(`.${name}`));
  if (local) return `${host} is a local or reserved name (${local}), not a public web site`;
  const alias = LOCAL_ALIASES.find((name) => host === name || host.endsWith(`.${name}`));
  if (alias) return `${host} resolves to your own machine or network (${alias}), not a public web site`;
  if (labels.length < 2) return `${host} is a single name, not a public web site`;
  const parsed = parse(host, { allowPrivateDomains: true, detectIp: true });
  if (parsed.isIp) return `${host} is an IP address, not a public web site`;
  if (!parsed.isIcann && !parsed.isPrivate) return `${host} is not under a known public suffix`;
  if (parsed.domain === null) return `${host} is a public suffix (anyone can register a site under it), not one site`;
  return null;
}

export function isPublicHost(host: string): boolean {
  return publicHostProblem(host) === null;
}
