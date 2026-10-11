// Test helpers: a mock orchestrator with instant timers and a fixed clock, for unit tests of the
// screens and their lib/api adapters (e2e drives the browser's own mock through withMock).
import { MockBackend } from "./backend";
import type { MockState } from "./state";

export const TEST_NOW = new Date("2026-10-11T03:00:00Z");

export interface TestMockOptions {
  now?: () => number;
  /** The simulated bots' waits; instant by default (see gatedSleep to hold them). */
  sleep?: (ms: number) => Promise<void>;
  state?: (s: MockState) => void;
}

export function testMock(o: TestMockOptions = {}): MockBackend {
  const mock = new MockBackend({ sleep: o.sleep ?? (() => Promise.resolve()), now: o.now ?? (() => TEST_NOW.getTime()) });
  o.state?.(mock.state);
  return mock;
}

/**
 * Waits that only end when the test says so: the simulated bots stand still until `release()`, so
 * a test can check the in-between state (e.g. "Research is answering…") without racing a timer.
 */
export function gatedSleep(): { sleep: (ms: number) => Promise<void>; release: () => void } {
  let open = false;
  const waiting: (() => void)[] = [];
  return {
    sleep: () => (open ? Promise.resolve() : new Promise<void>((resolve) => waiting.push(resolve))),
    release: () => {
      open = true;
      for (const resolve of waiting.splice(0)) resolve();
    },
  };
}
