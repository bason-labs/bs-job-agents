// A manual clock for deterministic tests: time moves only when the test advances it, and due
// timers fire in time order (timers set by timers included).
import type { Clock } from "../ports.js";

interface FakeTimer {
  at: number;
  seq: number;
  fn: () => void;
}

export class FakeClock implements Clock {
  private t: number;
  private seq = 0;
  private readonly timers = new Map<number, FakeTimer>();

  constructor(start: Date | string) {
    this.t = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.t);
  }

  setTimer(delayMs: number, fn: () => void): number {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, delayMs), seq: id, fn });
    return id;
  }

  clearTimer(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** Move time forward by `ms`, firing every timer that falls due on the way. */
  advance(ms: number): void {
    this.runUntil(this.t + ms);
  }

  advanceTo(at: Date | string): void {
    this.runUntil(Math.max(this.t, new Date(at).getTime()));
  }

  /** Resolves when the clock has been advanced by `ms`. */
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.setTimer(ms, resolve));
  }

  pendingTimers(): number {
    return this.timers.size;
  }

  /** When the next timer falls due, or null. */
  nextTimerAt(): Date | null {
    let next: number | null = null;
    for (const timer of this.timers.values()) if (next === null || timer.at < next) next = timer.at;
    return next === null ? null : new Date(next);
  }

  private runUntil(target: number): void {
    for (;;) {
      let due: [number, FakeTimer] | null = null;
      for (const entry of this.timers) {
        const [, timer] = entry;
        if (timer.at > target) continue;
        if (!due || timer.at < due[1].at || (timer.at === due[1].at && timer.seq < due[1].seq)) due = entry;
      }
      if (!due) break;
      this.timers.delete(due[0]);
      this.t = Math.max(this.t, due[1].at);
      due[1].fn();
    }
    this.t = Math.max(this.t, target);
  }
}
