// Live 2026-10-20: the Chrome browser bots use when several Claude in Chrome extensions are
// connected. Ba chooses it (Bots screen); the orchestrator has no Chrome connection of its own, so
// the browsers offered are the ones the bots' Chrome tools reported. Both are audit rows (no
// migration): the latest `settings.chrome_browser` row is the choice, the latest
// `chrome.browsers_seen` row per deviceId is what Ba can pick from.
import type { Conn } from "../client.js";
import type { ClockOpts } from "../time.js";
import { appendEvent, listEvents } from "./events.js";

export interface ChromeBrowserRecord {
  deviceId: string;
  name: string | null;
  os: string | null;
  isLocal: boolean | null;
}

const CHOICE = "settings.chrome_browser";
const SEEN = "chrome.browsers_seen";

const asRecord = (v: unknown): ChromeBrowserRecord | null => {
  const o = v as Partial<ChromeBrowserRecord> | null;
  if (!o || typeof o.deviceId !== "string" || !o.deviceId) return null;
  return { deviceId: o.deviceId, name: typeof o.name === "string" ? o.name : null, os: typeof o.os === "string" ? o.os : null, isLocal: typeof o.isLocal === "boolean" ? o.isLocal : null };
};

/** The browser Ba chose for bots, or null. */
export function getPreferredBrowser(db: Conn): ChromeBrowserRecord | null {
  const last = listEvents(db, { types: [CHOICE] }).at(-1);
  return last ? asRecord((last.payload as { browser?: unknown }).browser) : null;
}

/** Set (or, with null, clear) the browser bots select. */
export function setPreferredBrowser(db: Conn, browser: ChromeBrowserRecord | null, opts?: ClockOpts): void {
  appendEvent(db, { type: CHOICE, payload: { browser: browser ? { ...browser } : null } }, opts);
}

/** Browsers a task's Chrome tools reported. */
export function recordSeenBrowsers(db: Conn, browsers: readonly ChromeBrowserRecord[], opts?: ClockOpts & { taskId?: number | null }): void {
  const valid = browsers.map(asRecord).filter((b): b is ChromeBrowserRecord => b !== null);
  if (valid.length === 0) return;
  appendEvent(db, { type: SEEN, payload: { browsers: valid.map((b) => ({ ...b })) }, taskId: opts?.taskId ?? null }, opts);
}

/** Every browser ever reported, newest report first, one per deviceId. */
export function listSeenBrowsers(db: Conn): (ChromeBrowserRecord & { seenAt: string })[] {
  const out = new Map<string, ChromeBrowserRecord & { seenAt: string }>();
  for (const row of [...listEvents(db, { types: [SEEN] })].reverse()) {
    for (const raw of ((row.payload as { browsers?: unknown[] }).browsers ?? []) as unknown[]) {
      const b = asRecord(raw);
      if (b && !out.has(b.deviceId)) out.set(b.deviceId, { ...b, seenAt: row.createdAt });
    }
  }
  return [...out.values()];
}
