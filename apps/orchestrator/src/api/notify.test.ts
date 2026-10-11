import type { AppEvent, Message, MessageCard } from "@bs-job-agents/shared";
import { describe, expect, it } from "vitest";
import { getOrCreateLeadRoom } from "../db/index.js";
import { createTestEngine } from "../engine/testing/index.js";
import { postMessage } from "./chat/messages.js";
import { engineEventHub } from "./context.js";
import { appleScriptString, defaultNotifier, notificationFor, osascriptNotifier, startNotifications, type Notification } from "./notify.js";

function created(cards: MessageCard[], over: Partial<Message> = {}): AppEvent {
  const message: Message = {
    id: "1",
    roomId: "1",
    author: { type: "bot", bot: "lead" },
    text: "3 review cards are ready",
    mode: "work",
    mentions: [],
    runIds: [],
    uploadIds: [],
    cards,
    createdAt: "2026-10-10T08:00:00.000Z",
    ...over,
  };
  return { id: "1", at: message.createdAt, type: "message.created", roomId: "1", message };
}

function paused(code: "needs_browser" | "needs_figma" | "needs_login", at: string, taskId = "4"): AppEvent {
  return { id: taskId, at, type: "task.paused", taskId, runId: "1", botName: "research", reason: { code, site: null, detail: null } } as AppEvent;
}

describe("§10.3 Chrome not open → Ba gets a notification (Phase 3 QA)", () => {
  it("notifies once when browser or Figma steps start waiting, not for every waiting task", () => {
    const sent: Notification[] = [];
    const listeners: ((e: AppEvent) => void)[] = [];
    const hub = { subscribe: (l: (e: AppEvent) => void) => (listeners.push(l), () => {}) } as unknown as Parameters<typeof startNotifications>[0];
    startNotifications(hub, (n) => sent.push(n));
    const emit = (e: AppEvent) => listeners.forEach((l) => l(e));
    emit(paused("needs_browser", "2026-10-10T08:00:00.000Z", "4"));
    emit(paused("needs_browser", "2026-10-10T08:01:00.000Z", "5"));
    emit(paused("needs_figma", "2026-10-10T08:02:00.000Z", "6"));
    emit(paused("needs_login", "2026-10-10T08:02:00.000Z", "7"));
    expect(sent.map((n) => n.title)).toEqual(["Chrome is not connected", "Figma is not connected"]);
    // A new wait later on notifies again.
    emit(paused("needs_browser", "2026-10-10T09:00:00.000Z", "8"));
    expect(sent.map((n) => n.title)).toEqual(["Chrome is not connected", "Figma is not connected", "Chrome is not connected"]);
  });
});

describe("macOS notifications (UC-02, decision 4)", () => {
  it("notifies for Lead's summary with review cards and for Lead needing Ba; nothing else", () => {
    expect(notificationFor(created([{ type: "review_link", count: 3 }]))).toEqual({ title: "Review cards ready", body: "3 review cards are ready" });
    expect(notificationFor(created([{ type: "pause", taskId: "4", reason: "needs_login" }]))?.title).toBe("Lead needs you");
    expect(notificationFor(created([]))).toBeNull();
    expect(notificationFor(created([{ type: "review_link", count: 1 }], { author: { type: "bot", bot: "qa" }, mode: "consult" }))).toBeNull();
    expect(notificationFor(created([{ type: "review_link", count: 1 }], { author: { type: "ba" } }))).toBeNull();
  });

  it("runs osascript without a shell, with the text escaped for AppleScript", () => {
    const calls: { file: string; args: readonly string[] }[] = [];
    osascriptNotifier((file, args, cb) => {
      calls.push({ file, args });
      cb(null);
    })({ title: 'Lead "needs" you', body: "line one\nline \\ two" });
    expect(calls).toEqual([{ file: "/usr/bin/osascript", args: ["-e", 'display notification "line one line \\\\ two" with title "Lead \\"needs\\" you"'] }]);
    expect(appleScriptString("x".repeat(500)).length).toBeLessThan(200);
  });

  it("is off outside macOS and with ORCH_NOTIFY=0", () => {
    expect(defaultNotifier({}, "linux")).toBeNull();
    expect(defaultNotifier({ ORCH_NOTIFY: "0" }, "darwin")).toBeNull();
    expect(defaultNotifier({}, "darwin")).toBeTypeOf("function");
  });

  it("fires from committed message.created events", async () => {
    const t = await createTestEngine();
    const sent: Notification[] = [];
    const stop = startNotifications(engineEventHub(t.engine), (n) => sent.push(n));
    t.db.transaction((tx) => postMessage(tx, { room: getOrCreateLeadRoom(tx), author: "lead", text: "2 cards ready", cards: [{ type: "review_link", count: 2 }] }, t.clock.now()));
    t.engine.bus.flush();
    stop();
    expect(sent).toEqual([{ title: "Review cards ready", body: "2 cards ready" }]);
    t.engine.stop();
    t.db.$client.close();
  });
});
