// Test helpers: a mock orchestrator with instant timers and a fixed clock, for unit tests of the
// screens and their lib/api adapters (e2e drives the browser's own mock through withMock).
import { MockBackend } from "./backend";
import type { MockState } from "./state";

export const TEST_NOW = new Date("2026-10-11T03:00:00Z");

export function testMock(o: { now?: () => number; state?: (s: MockState) => void } = {}): MockBackend {
  const mock = new MockBackend({ sleep: () => Promise.resolve(), now: o.now ?? (() => TEST_NOW.getTime()) });
  o.state?.(mock.state);
  return mock;
}
