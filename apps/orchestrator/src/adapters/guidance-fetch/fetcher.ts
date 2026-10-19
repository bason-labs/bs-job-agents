// CV guidance (§5.4 step 1, SEC-21): the orchestrator's own fetcher for guidance pages. No model is
// involved: code GETs each page and reduces it to plain text. Polite and closed by design, like the
// feed scanner (adapters/feeds/scanner.ts): a fixed User-Agent, one request at a time per host with a
// gap between them, a timeout and a size cap; plus the SEC-21 policy:
// - https only, port 443, no credentials in the URL, a public registrable host name;
// - every address the host resolves to is public (not loopback, private, link-local, CGNAT,
//   multicast or reserved), checked again after each redirect, at most 3 redirects;
// - no cookie, Authorization or board token: the request headers are this fixed list;
// - 2 MiB and 20 s per page; the caller caps pages per refresh (15).
// Conditional GETs (If-None-Match / If-Modified-Since) make an unchanged page a 304 with no body.
// DNS rebinding (F6): the default transport is node:https with a lookup hook that validates the
// very addresses the socket connects to, so a name that resolves publicly for the check and
// privately for the connection is refused at connect time.
import { createHash } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { classifySource, guidanceContentKey, publicHostProblem, registrableHost } from "@bs-job-agents/shared";
import type { GuidanceFetchPort, GuidanceFetchRequest, GuidanceFetchResult } from "../../engine/ports.js";
import { htmlTitle, mainText } from "./text.js";

/** The subset of a fetch Response the fetcher reads. */
export interface GuidanceHttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Uint8Array> | null;
}

/** The subset of `fetch` the fetcher uses (injectable: tests pass a fake, so nothing reaches the network). */
export type GuidanceHttpFetch = (url: string, init: { method: "GET"; headers: Record<string, string>; redirect: "manual"; signal: AbortSignal }) => Promise<GuidanceHttpResponse>;

/** Every address a host name resolves to (injectable). */
export type GuidanceResolver = (host: string) => Promise<string[]>;

export interface GuidanceFetcherOptions {
  fetch?: GuidanceHttpFetch;
  resolve?: GuidanceResolver;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  userAgent?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Pause between two requests to the same host. */
  minGapMs?: number;
  /** Hosts fetched at the same time. */
  concurrency?: number;
}

export const GUIDANCE_USER_AGENT = "bs-job-agents/0.1 (personal CV guidance check; reads a few public career-advice pages once a day)";
export const GUIDANCE_MAX_BYTES = 2 * 1024 * 1024;
export const GUIDANCE_TIMEOUT_MS = 20_000;
export const GUIDANCE_MAX_REDIRECTS = 3;
export const GUIDANCE_HOST_GAP_MS = 1_500;

/** The only headers a guidance request carries (SEC-21: no cookie, Authorization or token). */
export function guidanceRequestHeaders(userAgent: string, req: Pick<GuidanceFetchRequest, "etag" | "lastModified"> | null): Record<string, string> {
  return {
    "User-Agent": userAgent,
    Accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8",
    "Accept-Language": "vi,en;q=0.8",
    ...(req?.etag ? { "If-None-Match": req.etag } : {}),
    ...(req?.lastModified ? { "If-Modified-Since": req.lastModified } : {}),
  };
}

const V4_BLOCKED: [number, number][] = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24],
  [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24], [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4],
];

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}

/** An IPv6 address as 8 numbers (an embedded dotted IPv4 tail included), or null. */
function v6Parts(ip: string): number[] | null {
  let a = ip.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (v4) {
    if (isIP(v4[1]!) !== 4) return null;
    const n = v4ToInt(v4[1]!);
    a = `${a.slice(0, -v4[1]!.length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = a.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const parts = [...head, ...Array.from({ length: fill }, () => "0"), ...tail].map((h) => parseInt(h, 16));
  return parts.length === 8 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 0xffff) ? parts : null;
}

const embeddedV4 = (hi: number, lo: number): string => [hi >>> 8, hi & 0xff, lo >>> 8, lo & 0xff].join(".");

/**
 * A public unicast address (SEC-21, F6): not loopback, private, link-local, CGNAT, multicast or
 * reserved; for IPv6 also not site-local, unique-local, documentation, and never an IPv4 address
 * hidden in it (IPv4-mapped or -compatible, 6to4, NAT64) that is not public itself.
 */
export function isPublicAddress(ip: string): boolean {
  const kind = isIP(ip.replace(/^\[|\]$/g, "").replace(/%.*$/, ""));
  if (kind === 4) {
    const n = v4ToInt(ip);
    return !V4_BLOCKED.some(([base, bits]) => (n >>> (32 - bits)) === (base >>> (32 - bits)));
  }
  if (kind !== 6) return false;
  const p = v6Parts(ip);
  if (!p) return false;
  const [a, b] = p as [number, number, ...number[]];
  if (p.every((x) => x === 0)) return false; // ::
  if (p.slice(0, 7).every((x) => x === 0) && p[7] === 1) return false; // ::1
  // ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible), 64:ff9b::a.b.c.d (NAT64): the IPv4 decides.
  if (p.slice(0, 5).every((x) => x === 0) && (p[5] === 0xffff || p[5] === 0)) return isPublicAddress(embeddedV4(p[6]!, p[7]!));
  if (a === 0x64 && b === 0xff9b) return isPublicAddress(embeddedV4(p[6]!, p[7]!));
  if (a === 0x2002) return isPublicAddress(embeddedV4(b, p[2]!)); // 6to4
  if ((a & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((a & 0xffc0) === 0xfe80 || (a & 0xffc0) === 0xfec0) return false; // link-local, site-local
  if ((a & 0xff00) === 0xff00) return false; // multicast
  if (a === 0x2001 && b === 0x0db8) return false; // documentation
  if (a === 0x0100 && p[1] === 0 && p[2] === 0 && p[3] === 0) return false; // discard-only
  if (a === 0x2001 && b === 0) return false; // Teredo (embeds a client IPv4)
  return true;
}

const sleepFor = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });

const defaultResolve: GuidanceResolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

class PageError extends Error {}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
type LookupFn = (hostname: string, options: { all?: boolean; family?: number }, callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

/** A socket lookup that refuses any non-public address it would connect to (F6, SEC-21). */
export function validatingLookup(resolve: LookupFn = (h, o, cb) => dnsLookup(h, { ...o, all: true }, cb)) {
  return (hostname: string, options: { all?: boolean; family?: number }, callback: LookupCallback): void => {
    resolve(hostname, { family: options.family ?? 0, all: true }, (err, addresses) => {
      if (err) return callback(err, "");
      const bad = addresses.find((a) => !isPublicAddress(a.address));
      if (bad || addresses.length === 0) {
        const e = new Error(`${hostname} resolves to a non-public address (${bad?.address ?? "none"})`) as NodeJS.ErrnoException;
        e.code = "ENOTPUBLIC";
        return callback(e, "");
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

/** The default transport: node:https, the validating lookup, no redirects followed, no agent cookies. */
export const pinnedHttpsFetch: GuidanceHttpFetch = (url, init) =>
  new Promise((resolve, reject) => {
    const req = request(url, { method: "GET", headers: init.headers, signal: init.signal, lookup: validatingLookup() as never }, (res) =>
      resolve({
        status: res.statusCode ?? 0,
        headers: {
          get: (name) => {
            const v = res.headers[name.toLowerCase()];
            return Array.isArray(v) ? v.join(", ") : (v ?? null);
          },
        },
        body: res,
      }),
    );
    req.on("error", reject);
    req.end();
  });

export class GuidanceFetcher implements GuidanceFetchPort {
  private readonly fetchFn: GuidanceHttpFetch;
  private readonly resolve: GuidanceResolver;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxRedirects: number;
  private readonly minGapMs: number;
  private readonly concurrency: number;
  private readonly lastRequestAt = new Map<string, number>();

  constructor(opts: GuidanceFetcherOptions = {}) {
    this.fetchFn = opts.fetch ?? pinnedHttpsFetch;
    this.resolve = opts.resolve ?? defaultResolve;
    this.sleep = opts.sleep ?? sleepFor;
    this.now = opts.now ?? (() => Date.now());
    this.userAgent = opts.userAgent ?? GUIDANCE_USER_AGENT;
    this.timeoutMs = opts.timeoutMs ?? GUIDANCE_TIMEOUT_MS;
    this.maxBytes = opts.maxBytes ?? GUIDANCE_MAX_BYTES;
    this.maxRedirects = opts.maxRedirects ?? GUIDANCE_MAX_REDIRECTS;
    this.minGapMs = opts.minGapMs ?? GUIDANCE_HOST_GAP_MS;
    this.concurrency = opts.concurrency ?? 3;
  }

  /** Fetch every page; one host's pages in order with the gap, a few hosts at a time. Never throws. */
  async fetchPages(requests: readonly GuidanceFetchRequest[], opts: { signal?: AbortSignal } = {}): Promise<GuidanceFetchResult[]> {
    const results = new Map<number, GuidanceFetchResult>();
    const byHost = new Map<string, number[]>();
    requests.forEach((r, i) => {
      let host = "";
      try {
        host = new URL(r.url).hostname.toLowerCase();
      } catch {
        host = `invalid:${i}`;
      }
      byHost.set(host, [...(byHost.get(host) ?? []), i]);
    });
    const queues = [...byHost.values()];
    const worker = async () => {
      for (let q = queues.shift(); q; q = queues.shift()) {
        for (const i of q) results.set(i, await this.fetchOne(requests[i]!, opts.signal));
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, queues.length) }, worker));
    return requests.map((r, i) => results.get(i) ?? { url: r.url, status: "failed", reason: "not fetched" });
  }

  private async fetchOne(req: GuidanceFetchRequest, signal?: AbortSignal): Promise<GuidanceFetchResult> {
    try {
      return await this.fetchFollowing(req, signal);
    } catch (err) {
      const reason = err instanceof PageError ? err.message : signal?.aborted ? "cancelled" : `the request failed (${err instanceof Error ? err.message : String(err)})`;
      return { url: req.url, status: "failed", reason };
    }
  }

  /** SEC-21's URL policy; throws PageError with the reason. */
  private async checkUrl(raw: string): Promise<URL> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new PageError("not a URL");
    }
    if (url.protocol !== "https:") throw new PageError(`${url.protocol.replace(/:$/, "")} is not https`);
    if (url.port !== "" && url.port !== "443") throw new PageError(`port ${url.port} is not allowed`);
    if (url.username || url.password) throw new PageError("the URL carries credentials");
    const host = url.hostname.toLowerCase();
    if (isIP(host.replace(/^\[|\]$/g, ""))) throw new PageError(`${host} is an IP address, not a public site`);
    const problem = publicHostProblem(host);
    if (problem) throw new PageError(problem);
    let addresses: string[];
    try {
      addresses = await this.resolve(host);
    } catch (err) {
      throw new PageError(`${host} does not resolve (${err instanceof Error ? err.message : String(err)})`);
    }
    if (addresses.length === 0) throw new PageError(`${host} does not resolve`);
    const bad = addresses.find((a) => !isPublicAddress(a));
    if (bad) throw new PageError(`${host} resolves to a non-public address (${bad})`);
    return url;
  }

  private async politeWait(host: string, signal?: AbortSignal): Promise<void> {
    const last = this.lastRequestAt.get(host);
    if (last !== undefined) await this.sleep(last + this.minGapMs - this.now(), signal);
    this.lastRequestAt.set(host, this.now());
  }

  private async fetchFollowing(req: GuidanceFetchRequest, signal?: AbortSignal): Promise<GuidanceFetchResult> {
    let current = req.url;
    // F5: one 20 s deadline for the page, across every redirect hop (not 20 s per hop).
    const deadline = this.now() + this.timeoutMs;
    const timedOut = () => new PageError(`no answer within ${Math.round(this.timeoutMs / 1000)} s`);
    for (let hop = 0; ; hop++) {
      if (signal?.aborted) throw new PageError("cancelled");
      if (this.now() >= deadline) throw timedOut();
      const url = await this.checkUrl(current);
      await this.politeWait(url.hostname, signal);
      if (signal?.aborted) throw new PageError("cancelled");
      if (this.now() >= deadline) throw timedOut();
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) controller.abort();
      const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - this.now()));
      try {
        // Validators only for the page as stored; never across a redirect.
        const res = await this.fetchFn(url.href, { method: "GET", headers: guidanceRequestHeaders(this.userAgent, hop === 0 ? req : null), redirect: "manual", signal: controller.signal });
        if (res.status === 304) return { url: req.url, status: "not_modified" };
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get("location");
          if (!location) throw new PageError(`HTTP ${res.status} without a Location`);
          if (hop + 1 > this.maxRedirects) throw new PageError(`more than ${this.maxRedirects} redirects`);
          current = new URL(location, url).href;
          continue;
        }
        if (res.status < 200 || res.status >= 300) throw new PageError(`HTTP ${res.status}`);
        const type = (res.headers.get("content-type") ?? "text/html").toLowerCase();
        if (!/text\/html|application\/xhtml\+xml|text\/plain/.test(type)) throw new PageError(`not a web page (${type.split(";")[0]})`);
        const length = Number(res.headers.get("content-length") ?? "0");
        if (length > this.maxBytes) throw new PageError(`larger than ${this.maxBytes} bytes`);
        const body = await this.readCapped(res, controller);
        const html = new TextDecoder("utf-8").decode(body);
        const text = /text\/plain/.test(type) ? html : mainText(html);
        const host = registrableHost(url.href) ?? url.hostname;
        const { kind, market } = classifySource(host, text);
        return {
          url: req.url,
          status: "ok",
          finalUrl: url.href,
          title: /text\/plain/.test(type) ? null : htmlTitle(html),
          text,
          contentHash: createHash("sha256").update(guidanceContentKey(text)).digest("hex"),
          etag: res.headers.get("etag"),
          lastModified: res.headers.get("last-modified"),
          host,
          kind,
          market,
        };
      } catch (err) {
        if (signal?.aborted && !(err instanceof PageError)) throw new PageError("cancelled");
        if (controller.signal.aborted && !(err instanceof PageError)) throw timedOut();
        throw err;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    }
  }

  /** The body, stopping at the size cap (SEC-21.AC-3: reading stops at 2 MiB). */
  private async readCapped(res: GuidanceHttpResponse, controller: AbortController): Promise<Uint8Array> {
    if (!res.body) return new Uint8Array();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.byteLength;
      if (size > this.maxBytes) {
        controller.abort();
        throw new PageError(`larger than ${this.maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
  }
}
