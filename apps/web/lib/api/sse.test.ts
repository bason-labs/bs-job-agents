import { APP_EVENT_TYPES, type AppEvent } from "@bs-job-agents/shared";
import { sampleEvents } from "@bs-job-agents/shared/fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedStatus } from "./contract";
import { createLiveEventFeed, type EventSourceLike } from "./sse";

/** EventSource double: tests drive open / message / error by hand. */
class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  closed = false;
  readonly listeners = new Map<string, ((ev: MessageEvent) => void)[]>();
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (ev: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  send(event: AppEvent, raw?: string) {
    const ev = new MessageEvent(event.type, { data: raw ?? JSON.stringify(event), lastEventId: event.id });
    for (const fn of this.listeners.get(event.type) ?? []) fn(ev);
  }
  /** readyState CONNECTING = the browser retries by itself; CLOSED = it gave up. */
  fail(state: 0 | 2) {
    this.readyState = state;
    this.onerror?.(new Event("error"));
  }
}

const ev = (type: AppEvent["type"], id: string): AppEvent => ({ ...sampleEvents.find((e) => e.type === type)!, id });
const latest = () => FakeEventSource.instances.at(-1)!;

function feed(extra: Partial<Parameters<typeof createLiveEventFeed>[0]> = {}) {
  return createLiveEventFeed({
    url: "/api/events",
    createEventSource: (url) => new FakeEventSource(url),
    backoff: { initialMs: 1000, maxMs: 8000, factor: 2 },
    closeGraceMs: 500,
    ...extra,
  });
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("createLiveEventFeed", () => {
  it("connects on the first subscriber, listens to every shared event type and reports its status", () => {
    const f = feed();
    const statuses: FeedStatus[] = [];
    f.onStatus((s) => statuses.push(s));
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(f.getStatus()).toBe("idle");

    const got: AppEvent[] = [];
    f.subscribe((e) => got.push(e));
    expect(latest().url).toBe("/api/events");
    expect([...latest().listeners.keys()].sort()).toEqual([...APP_EVENT_TYPES].sort());
    latest().open();
    latest().send(ev("run.started", "1"));
    latest().send(ev("review.ready", "2"));
    expect(got.map((e) => [e.type, e.id])).toEqual([
      ["run.started", "1"],
      ["review.ready", "2"],
    ]);
    expect(statuses).toEqual(["connecting", "open"]);
  });

  it("skips frames that fail the shared schema and keeps streaming", () => {
    const onInvalid = vi.fn();
    const f = feed({ onInvalid });
    const got: string[] = [];
    f.subscribe((e) => got.push(e.id));
    latest().open();
    latest().send(ev("run.started", "1"), '{"type":"run.started","id":"1"}');
    latest().send(ev("run.updated", "2"), "not json");
    latest().send(ev("run.finished", "3"));
    expect(got).toEqual(["3"]);
    expect(onInvalid).toHaveBeenCalledTimes(2);
  });

  it("drops duplicates and replays older than the last event seen (numeric ids)", () => {
    const f = feed();
    const got: string[] = [];
    f.subscribe((e) => got.push(e.id));
    latest().open();
    latest().send(ev("run.started", "9"));
    latest().send(ev("run.started", "9"));
    latest().send(ev("run.updated", "10"));
    latest().send(ev("run.updated", "8"));
    expect(got).toEqual(["9", "10"]);
  });

  it("lets the browser retry by itself (Last-Event-ID header) while the source is still CONNECTING", () => {
    const f = feed();
    f.subscribe(() => {});
    latest().open();
    latest().fail(0);
    expect(f.getStatus()).toBe("reconnecting");
    vi.advanceTimersByTime(30_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    latest().open();
    expect(f.getStatus()).toBe("open");
  });

  it("reopens a CLOSED source with backoff and resumes from the last event id", () => {
    const f = feed();
    f.subscribe(() => {});
    latest().open();
    latest().send(ev("run.started", "41"));
    latest().send(ev("run.updated", "42"));

    latest().fail(2);
    expect(latest().closed).toBe(true);
    expect(f.getStatus()).toBe("reconnecting");
    vi.advanceTimersByTime(999);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(2);
    // W3a's /events takes ?after= (or the Last-Event-ID header the browser sends by itself).
    expect(latest().url).toBe("/api/events?after=42");

    // Still down: the wait doubles (2 s, then 4 s, capped at 8 s).
    latest().fail(2);
    vi.advanceTimersByTime(1999);
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(3);
    latest().fail(2);
    vi.advanceTimersByTime(4000);
    latest().fail(2);
    vi.advanceTimersByTime(8000);
    latest().fail(2);
    vi.advanceTimersByTime(8000);
    expect(FakeEventSource.instances).toHaveLength(6);

    // A successful open resets the backoff.
    latest().open();
    expect(f.getStatus()).toBe("open");
    latest().fail(2);
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(7);
  });

  it("closes after the last subscriber leaves (with a grace period for quick re-subscribes)", () => {
    const f = feed();
    const off1 = f.subscribe(() => {});
    latest().open();
    off1();
    vi.advanceTimersByTime(200);
    const off2 = f.subscribe(() => {});
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(latest().closed).toBe(false);
    off2();
    vi.advanceTimersByTime(500);
    expect(latest().closed).toBe(true);
    expect(f.getStatus()).toBe("idle");
  });

  it("one throwing subscriber does not starve the others", () => {
    const f = feed();
    const got: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    f.subscribe(() => {
      throw new Error("bad listener");
    });
    f.subscribe((e) => got.push(e.id));
    latest().open();
    latest().send(ev("run.started", "1"));
    expect(got).toEqual(["1"]);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
