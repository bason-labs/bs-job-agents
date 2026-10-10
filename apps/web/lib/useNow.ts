"use client";

import { useSyncExternalStore } from "react";

// One shared 1 s ticker; null during SSR/hydration so countdowns never mismatch.
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let now = 0;

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      listeners.forEach((l) => l());
    }, 1000);
  }
  return () => {
    listeners.delete(cb);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Current time (ms), refreshed every second while `enabled`; null on the server. */
export function useNow(enabled = true): number | null {
  return useSyncExternalStore(
    enabled ? subscribe : () => () => {},
    () => (enabled ? now || Date.now() : null),
    () => null,
  );
}

/** Whole seconds until `iso`, or null when not set / not mounted. */
export function secondsUntil(iso: string | null, nowMs: number | null): number | null {
  if (!iso || nowMs === null) return null;
  return Math.max(0, Math.ceil((Date.parse(iso) - nowMs) / 1000));
}
