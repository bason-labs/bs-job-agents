// Live updates (§11): one EventSource on the orchestrator's /events per tab (through the /api
// rewrite), shared by every subscriber. The server names each frame (`event: <type>`) and ids it
// (`id: <events row id>`); a first connection gets no history, only an id-only frame:
// - while the browser retries by itself (readyState CONNECTING, `retry: 3000`) it resends
//   Last-Event-ID and the server replays what was missed, in order;
// - when the source gives up (CLOSED, e.g. the proxy answered 502 or the API runs degraded), we
//   reopen it with backoff and `?after=<last id seen>`; screens also re-read over REST when the
//   feed is back (react.tsx), which covers an id we could not see (the id-only frame);
// - frames are validated with the shared schema (decodeSseData) and de-duplicated by id.
import { APP_EVENT_TYPES, decodeSseData, type AppEvent } from "@bs-job-agents/shared";
import type { EventFeed, EventListener, FeedStatus } from "./contract";

/** The part of EventSource the feed uses (tests pass a double). */
export interface EventSourceLike {
  readyState: number;
  onopen: ((ev: Event) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  addEventListener(type: string, listener: (ev: MessageEvent) => void): void;
  close(): void;
}

const CLOSED = 2;

export interface LiveFeedOptions {
  /** e.g. `/api/events` (same-origin rewrite to the orchestrator). */
  url: string;
  createEventSource?: (url: string) => EventSourceLike;
  backoff?: { initialMs: number; maxMs: number; factor: number };
  /** Keep the connection this long after the last subscriber leaves (route changes, StrictMode). */
  closeGraceMs?: number;
  onInvalid?: (raw: string, error: unknown) => void;
}

const DEFAULT_BACKOFF = { initialMs: 1000, maxMs: 30_000, factor: 2 };

/** Newer than the last id seen? Numeric ids compare as numbers; others only dedupe exact repeats. */
function isNewer(id: string, last: string | null, seen: Set<string>): boolean {
  if (seen.has(id)) return false;
  if (last !== null && /^\d+$/.test(id) && /^\d+$/.test(last)) return BigInt(id) > BigInt(last);
  return true;
}

export function createLiveEventFeed(opts: LiveFeedOptions): EventFeed {
  const backoff = opts.backoff ?? DEFAULT_BACKOFF;
  const graceMs = opts.closeGraceMs ?? 1500;
  const make = opts.createEventSource ?? ((url: string) => new EventSource(url) as unknown as EventSourceLike);
  const onInvalid =
    opts.onInvalid ??
    ((raw: string, error: unknown) => console.warn("Ignored an SSE frame the shared schema rejects", { raw: raw.slice(0, 200), error }));

  const listeners = new Set<EventListener>();
  const statusListeners = new Set<(s: FeedStatus) => void>();
  let status: FeedStatus = "idle";
  let source: EventSourceLike | null = null;
  let lastId: string | null = null;
  const seen = new Set<string>();
  let delay = backoff.initialMs;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const setStatus = (s: FeedStatus) => {
    if (s === status) return;
    status = s;
    for (const fn of [...statusListeners]) fn(s);
  };

  const deliver = (raw: string) => {
    let event: AppEvent;
    try {
      event = decodeSseData(raw);
    } catch (error) {
      onInvalid(raw, error);
      return;
    }
    if (!isNewer(event.id, lastId, seen)) return;
    seen.add(event.id);
    if (seen.size > 1000) seen.delete(seen.values().next().value as string);
    lastId = event.id;
    for (const fn of [...listeners]) {
      try {
        fn(event);
      } catch (error) {
        console.error("SSE subscriber failed", error);
      }
    }
  };

  const open = () => {
    retryTimer = null;
    const url = lastId === null ? opts.url : `${opts.url}${opts.url.includes("?") ? "&" : "?"}after=${encodeURIComponent(lastId)}`;
    const es = make(url);
    source = es;
    es.onopen = () => {
      if (source !== es) return;
      delay = backoff.initialMs;
      setStatus("open");
    };
    es.onerror = () => {
      if (source !== es) return;
      if (es.readyState !== CLOSED) {
        setStatus("reconnecting");
        return;
      }
      es.close();
      source = null;
      setStatus("reconnecting");
      retryTimer = setTimeout(open, delay);
      delay = Math.min(delay * backoff.factor, backoff.maxMs);
    };
    const handler = (ev: MessageEvent) => {
      if (source === es) deliver(String(ev.data));
    };
    for (const type of APP_EVENT_TYPES) es.addEventListener(type, handler);
    es.onmessage = handler;
  };

  const close = () => {
    closeTimer = null;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    source?.close();
    source = null;
    delay = backoff.initialMs;
    setStatus("idle");
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
      if (!source && !retryTimer) {
        setStatus("connecting");
        open();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && !closeTimer) closeTimer = setTimeout(close, graceMs);
      };
    },
    getStatus: () => status,
    onStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
  };
}
