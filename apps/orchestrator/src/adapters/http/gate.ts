// AD-2 (NFR-1): at least `minGapMs` (1500 ms) between two requests to one host on every
// non-browser path, feeds and board APIs alike. Requests to one host run one at a time, in order;
// other hosts do not wait. One gate per process (engine/wiring.ts) so every client shares it.
// Some hosts get a longer gap (HOST_MIN_GAPS_MS): LinkedIn's guest pages rate-limit by IP, so
// every request to linkedin.com (or a subdomain) waits at least 3 s (2026-10-20 addendum).

export const MIN_HOST_GAP_MS = 1_500;

/** Longer per-host gaps, by domain (the domain and its subdomains); never shorter than minGapMs. */
export const HOST_MIN_GAPS_MS: Readonly<Record<string, number>> = { "linkedin.com": 3_000 };

export const sleepFor = (ms: number, signal?: AbortSignal): Promise<void> =>
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

export interface HostGateOptions {
  now?: () => number;
  /** Waits `ms` (tests: a fake clock). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  minGapMs?: number;
  /** Per-domain gaps (default HOST_MIN_GAPS_MS). */
  hostGapsMs?: Readonly<Record<string, number>>;
}

export class HostGate {
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly minGapMs: number;
  private readonly hostGapsMs: Readonly<Record<string, number>>;
  /** When each host's last request was sent. */
  private readonly lastAt = new Map<string, number>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(opts: HostGateOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? sleepFor;
    this.minGapMs = opts.minGapMs ?? MIN_HOST_GAP_MS;
    this.hostGapsMs = opts.hostGapsMs ?? HOST_MIN_GAPS_MS;
  }

  /** The gap `host` keeps between two requests. */
  gapFor(host: string): number {
    const h = host.toLowerCase().replace(/\.$/, "");
    let gap = this.minGapMs;
    for (const [domain, ms] of Object.entries(this.hostGapsMs)) if (h === domain || h.endsWith(`.${domain}`)) gap = Math.max(gap, ms);
    return gap;
  }

  /** Runs `send` when it is `host`'s turn and the gap since its last request has passed. */
  run<T>(host: string, send: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const key = host.toLowerCase();
    const previous = this.queues.get(key) ?? Promise.resolve();
    const turn = previous
      .catch(() => undefined)
      .then(async () => {
        const last = this.lastAt.get(key);
        if (last !== undefined) await this.sleep(last + this.gapFor(key) - this.now(), signal);
        signal?.throwIfAborted();
        this.lastAt.set(key, this.now());
        return send();
      });
    this.queues.set(key, turn);
    return turn;
  }
}
