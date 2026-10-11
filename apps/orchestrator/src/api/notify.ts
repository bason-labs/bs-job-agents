// UC-02 / PM2 decision 4: a macOS notification when Lead posts a run's summary (review cards ready)
// or needs Ba (a UC-17 pause card, a UC-12 question). Sent by the server from the committed
// message.created events, so a notice is never sent for something that rolled back.
// `osascript -e 'display notification …'` runs without a shell; the text is escaped for AppleScript
// and cut short. Tests inject a recorder; ORCH_NOTIFY=0 turns it off.
import { execFile } from "node:child_process";
import type { AppEvent } from "@bs-job-agents/shared";
import type { EventHub } from "./context.js";

export interface Notification {
  title: string;
  body: string;
}

export type Notifier = (n: Notification) => void;

const NOTIFY_TEXT_MAX = 180;

/** An AppleScript string literal: quotes and backslashes escaped, one line, short. */
export function appleScriptString(text: string): string {
  const one = text.replace(/[\r\n\t]+/g, " ").trim();
  const short = one.length > NOTIFY_TEXT_MAX ? `${one.slice(0, NOTIFY_TEXT_MAX - 1)}…` : one;
  return `"${short.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

type Exec = (file: string, args: readonly string[], cb: (err: Error | null) => void) => void;

/** The real notifier: /usr/bin/osascript, no shell, errors ignored (a notification is best effort). */
export function osascriptNotifier(exec: Exec = (file, args, cb) => void execFile(file, [...args], { timeout: 5_000 }, (err) => cb(err))): Notifier {
  return ({ title, body }) => {
    exec("/usr/bin/osascript", ["-e", `display notification ${appleScriptString(body)} with title ${appleScriptString(title)}`], () => undefined);
  };
}

/** The notification for an event, or null: Lead's messages in the Lead chat that Ba should see now. */
export function notificationFor(event: AppEvent): Notification | null {
  if (event.type !== "message.created") return null;
  const m = event.message;
  if (m.mode !== "work" || m.author.type !== "bot" || m.author.bot !== "lead") return null;
  if (m.cards.some((c) => c.type === "pause" || c.type === "question")) return { title: "Lead needs you", body: m.text };
  if (m.cards.some((c) => c.type === "review_link")) return { title: "Review cards ready", body: m.text };
  return null;
}

/** Send a notification for each matching event; returns the unsubscribe. */
export function startNotifications(events: EventHub, notify: Notifier): () => void {
  return events.subscribe((event) => {
    const n = notificationFor(event);
    if (n) notify(n);
  });
}

/** The default: on macOS unless ORCH_NOTIFY=0. */
export function defaultNotifier(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Notifier | null {
  if (platform !== "darwin" || env.ORCH_NOTIFY === "0" || env.VITEST) return null;
  return osascriptNotifier();
}
