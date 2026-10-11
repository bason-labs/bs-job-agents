// Live-update seam for the shell (spec §11 "Live updates": SSE events). The api's event feed
// (SSE in live mode, the mock backend otherwise) is mapped onto ShellEvent by toShellEvent and
// applied by the reducer below.
import type { AppEvent } from "@bs-job-agents/shared";
import type { EventFeed } from "./contract";
import { toShellEvent } from "./map";
import type { BotLiveStatus, Engine, ShellData } from "./types";

export type ShellEvent =
  /** A fresh read of the whole shell (after the live connection came back). */
  | { type: "shell.replace"; data: ShellData }
  | { type: "bot.status"; name: string; status: BotLiveStatus }
  | { type: "engine.paused"; engine: Engine; pausedUntil: string }
  | { type: "engine.resumed"; engine: Engine }
  | { type: "engine.usage"; engine: Engine; utilization: number }
  | { type: "review.count"; reviewCount: number }
  | { type: "run.started"; runId: string }
  | { type: "run.finished"; runId: string }
  | { type: "chrome.status"; connected: boolean };

/** Pure: returns new ShellData with the event applied. */
export function applyShellEvent(data: ShellData, event: ShellEvent): ShellData {
  switch (event.type) {
    case "shell.replace":
      return event.data;
    case "bot.status":
      return { ...data, bots: data.bots.map((b) => (b.name === event.name ? { ...b, status: event.status } : b)) };
    case "engine.paused":
      return { ...data, usage: data.usage.map((u) => (u.engine === event.engine ? { ...u, pausedUntil: event.pausedUntil } : u)) };
    case "engine.resumed":
      return { ...data, usage: data.usage.map((u) => (u.engine === event.engine ? { ...u, pausedUntil: null } : u)) };
    case "engine.usage":
      return { ...data, usage: data.usage.map((u) => (u.engine === event.engine ? { ...u, utilization: event.utilization } : u)) };
    case "review.count":
      return { ...data, reviewCount: event.reviewCount };
    case "run.started":
      return { ...data, activeRunId: event.runId };
    case "run.finished":
      return data.activeRunId === event.runId ? { ...data, activeRunId: null } : data;
    case "chrome.status":
      return { ...data, chromeConnected: event.connected };
  }
}

/** Subscribes to shell events on the feed; returns an unsubscribe function. */
export function subscribeShellEvents(feed: EventFeed, onEvent: (event: ShellEvent) => void): () => void {
  return feed.subscribe((event) => {
    const shellEvent = toShellEvent(event);
    if (shellEvent) onEvent(shellEvent);
  });
}

/**
 * Events after which the sidebar's review count may have changed: a card became ready, Ba
 * decided on one (its review step finished or re-opened), or a run ended. The shell then
 * re-reads the queue size instead of guessing from the event.
 */
export function affectsReviewCount(event: AppEvent): boolean {
  switch (event.type) {
    case "review.ready":
    case "run.finished":
      return true;
    case "step.started":
    case "step.updated":
    case "step.finished":
      return event.stepKey === "review";
    default:
      return false;
  }
}
