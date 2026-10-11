// Feed sources in a job scan (W5): the orchestrator fetches the board's public feed itself, with no
// bot, no LLM and no Claude/Codex quota, and answers in the research.scan output shape, so the
// scan's join → dedupe → fit (LLM) → top steps treat it like any other source.
// Polite by design: a fixed User-Agent that says what this is, one request at a time per board with
// a pause between them, a response cache per URL (Remotive: 6 h, it asks for ≤ 4 calls a day;
// others 1 h), a timeout and a size cap. A failed request fails the source; the scan goes on with
// the others (requireAll: false on the join).
import {
  ResearchScanOutputSchema,
  SEARCH_SOURCES,
  type FeedSource,
  type JobCandidate,
  type ResearchScanInput,
  type ResearchScanOutput,
} from "@bs-job-agents/shared";
import { scanJobLimit } from "../sources.js";
import { detectLanguage } from "../text.js";
import { FEED_ADAPTERS } from "./boards.js";
import { filterPostings, type DropReason } from "./filter.js";
import type { FeedAdapter, FeedPosting } from "./types.js";

/** The subset of `fetch` the scanner uses (injectable: tests pass a fake). */
export type FeedFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface FeedScannerOptions {
  fetch?: FeedFetch;
  now?: () => number;
  /** Waits `ms` (tests: resolve at once). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  userAgent?: string;
  /** Per request. */
  timeoutMs?: number;
  /** Pause between two requests to the same board. */
  minGapMs?: number;
  maxBodyBytes?: number;
  /** Override a board's cache lifetime (tests). */
  cacheTtlMs?: Partial<Record<FeedSource, number>>;
}

export const FEED_USER_AGENT = "bs-job-agents/0.1 (personal job search; reads public job feeds a few times a day; links back to each posting)";

export class FeedError extends Error {
  constructor(
    readonly source: FeedSource,
    message: string,
  ) {
    super(message);
    this.name = "FeedError";
  }
}

const sleepFor = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      },
      { once: true },
    );
  });

const DROP_LABELS: Record<DropReason, string> = {
  role: "not one of the roles",
  include: "none of the must-include keywords",
  exclude: "an excluded keyword",
  company: "an excluded company",
  seniority: "another seniority",
  region: "outside the time-zone overlap",
  salary: "under the minimum salary",
  snippet: "no full JD in the feed",
};

export class FeedScanner {
  private readonly fetchFn: FeedFetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly minGapMs: number;
  private readonly maxBodyBytes: number;
  private readonly ttl: Partial<Record<FeedSource, number>>;
  private readonly cache = new Map<string, { at: number; body: string }>();
  /** When each board's last request was sent; requests to one board run one at a time. */
  private readonly lastRequestAt = new Map<FeedSource, number>();
  private readonly queues = new Map<FeedSource, Promise<unknown>>();

  constructor(opts: FeedScannerOptions = {}) {
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? sleepFor;
    this.userAgent = opts.userAgent ?? FEED_USER_AGENT;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.minGapMs = opts.minGapMs ?? 1_500;
    this.maxBodyBytes = opts.maxBodyBytes ?? 8 * 1024 * 1024;
    this.ttl = opts.cacheTtlMs ?? {};
  }

  /** One feed source for one scan: research.scan's input in, its output shape out. Throws FeedError. */
  async scan(source: FeedSource, input: Pick<ResearchScanInput, "criteria" | "candidateLimit">, signal?: AbortSignal): Promise<ResearchScanOutput> {
    const adapter = FEED_ADAPTERS[source];
    const label = SEARCH_SOURCES[source].label;
    const postings: FeedPosting[] = [];
    let fetched = 0;
    for (const req of adapter.requests(input.criteria)) {
      const { body, fromCache } = await this.get(adapter, req.url, signal);
      if (!fromCache) fetched++;
      try {
        postings.push(...adapter.parse(body));
      } catch (err) {
        throw new FeedError(source, `${label}: the feed at ${req.url} could not be read (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    // One posting once, even when two of the board's feeds list it (WWR's categories overlap).
    const unique = [...new Map(postings.map((p) => [p.url, p])).values()];
    const { kept, dropped } = filterPostings(unique, input.criteria);
    const limit = input.candidateLimit ?? scanJobLimit(input.criteria.maxJobs);
    const newest = kept.sort((a, b) => (b.postedAt ?? "").localeCompare(a.postedAt ?? "")).slice(0, limit);
    const counts = new Map<DropReason, number>();
    for (const d of dropped) counts.set(d.reason, (counts.get(d.reason) ?? 0) + 1);
    const why = [...counts].map(([r, n]) => `${n} ${DROP_LABELS[r]}`).join(", ");
    const output: ResearchScanOutput = {
      jobs: newest.map(toCandidate),
      pageViews: 0,
      blocked: null,
      injectionSuspected: false,
      injectionNote: null,
      selfCheck: [
        {
          item: `Read the ${label} feed directly (no bot, no LLM)`,
          passed: true,
          note: `${unique.length} postings, ${kept.length} fit the search criteria${why ? ` (left out: ${why})` : ""}${kept.length > newest.length ? `; the newest ${newest.length} kept` : ""}; ${fetched} request${fetched === 1 ? "" : "s"} sent`,
        },
      ],
      memoryNotes: [],
    };
    return ResearchScanOutputSchema.parse(output);
  }

  /** A cached or fresh response body; requests to one board wait their turn and keep a gap. */
  private async get(adapter: FeedAdapter, url: string, signal?: AbortSignal): Promise<{ body: string; fromCache: boolean }> {
    const ttl = this.ttl[adapter.source] ?? adapter.cacheTtlMs;
    const hit = this.cache.get(url);
    if (hit && this.now() - hit.at < ttl) return { body: hit.body, fromCache: true };
    const previous = this.queues.get(adapter.source) ?? Promise.resolve();
    const turn = previous.catch(() => undefined).then(() => this.fetchPolitely(adapter, url, signal));
    this.queues.set(adapter.source, turn);
    const body = await turn;
    return { body, fromCache: false };
  }

  private async fetchPolitely(adapter: FeedAdapter, url: string, signal?: AbortSignal): Promise<string> {
    const label = SEARCH_SOURCES[adapter.source].label;
    const last = this.lastRequestAt.get(adapter.source);
    if (last !== undefined) await this.sleep(last + this.minGapMs - this.now(), signal);
    signal?.throwIfAborted();
    this.lastRequestAt.set(adapter.source, this.now());
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Awaited<ReturnType<FeedFetch>>;
    try {
      res = await this.fetchFn(url, { headers: { "User-Agent": this.userAgent, Accept: "application/json, application/rss+xml, application/xml;q=0.9, */*;q=0.5" }, signal: combined });
    } catch (err) {
      if (signal?.aborted) throw err;
      const why = timeout.aborted ? `no answer within ${Math.round(this.timeoutMs / 1000)} s` : err instanceof Error ? err.message : String(err);
      throw new FeedError(adapter.source, `${label}: could not reach ${url} (${why})`);
    }
    if (!res.ok) {
      const hint = res.status === 429 ? " (rate limited: try again later)" : res.status === 403 ? " (refused)" : "";
      throw new FeedError(adapter.source, `${label}: ${url} answered HTTP ${res.status}${hint}`);
    }
    const body = await res.text();
    if (body.length > this.maxBodyBytes) throw new FeedError(adapter.source, `${label}: the feed at ${url} is larger than ${this.maxBodyBytes} bytes`);
    this.cache.set(url, { at: this.now(), body });
    return body;
  }
}

function toCandidate(p: FeedPosting): JobCandidate {
  const region = p.regionText.length > 200 ? `${p.regionText.slice(0, 199).trimEnd()}…` : p.regionText;
  const jdText = region ? `Remote region: ${region}\n${p.jdText}` : p.jdText;
  return {
    source: p.source,
    url: p.url,
    title: p.title,
    company: p.company,
    companyWebsite: p.companyWebsite,
    // One location for every remote posting, so the same job on two boards dedupes (company + title + location).
    location: "Remote",
    workMode: "remote",
    salaryText: p.salaryText,
    postedAt: p.postedAt,
    language: detectLanguage(p.jdText),
    jdText,
  };
}
