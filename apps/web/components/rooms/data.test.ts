import { CSRF_HEADER, MessageSchema, RoomSchema, type Message } from "@bs-job-agents/shared";
import { describe, expect, it } from "vitest";
import { apiErrorInfo } from "@/components/schedules/apiError";
import { createHttpApi } from "@/lib/api/http";
import { testMock } from "@/lib/api/mock/testing";
import { createRoomsData, mentionableBots } from "./data";

describe("rooms adapter (UC-15)", () => {
  it("has #cv-brainstorm and its conversation; direct rooms come from GET /rooms too", async () => {
    const data = createRoomsData(testMock());
    const room = RoomSchema.parse(await data.getRoom("cv-brainstorm"));
    expect(room).toMatchObject({ kind: "group", members: ["lead", "research", "cv", "qa", "apply"] });
    const { messages, hasMore } = await data.messages("cv-brainstorm");
    expect(hasMore).toBe(false);
    expect(messages.map((m) => (m.author.type === "bot" ? m.author.bot : m.author.type))).toEqual(["ba", "cv", "qa"]);
    for (const m of messages) expect(() => MessageSchema.parse(m)).not.toThrow();
    expect(await data.getRoom("nope")).toBeNull();
    expect((await data.rooms()).filter((r) => r.kind === "direct").map((r) => r.botName)).toEqual(["research", "cv", "qa", "apply"]);
  });

  it("sends with POST /chat/messages; each mentioned member answers in turn via message.created", async () => {
    const mock = testMock();
    const data = createRoomsData(mock);
    const replies: string[] = [];
    data.subscribe("cv-brainstorm", { onMessage: (m: Message) => void (m.author.type === "bot" && replies.push(m.author.bot)) });
    const mine = await data.send("cv-brainstorm", "@Research @Apply what do you think?");
    expect(mine).toMatchObject({ author: { type: "ba" }, mentions: ["research", "apply"], mode: "discussion" });
    await mock.idle();
    expect(replies).toEqual(["research", "apply"]);
    expect((await data.messages("cv-brainstorm")).messages.at(-1)!.text).toMatch(/discussion mode/);
  });

  it("sends a message without a mention to no bot; a mentioned outsider gets the server's note", async () => {
    const mock = testMock();
    mock.state.rooms.find((r) => r.id === "cv-brainstorm")!.members = ["cv"];
    const data = createRoomsData(mock);
    const seen: Message[] = [];
    data.subscribe("cv-brainstorm", { onMessage: (m) => void seen.push(m) });
    expect((await data.send("cv-brainstorm", "just thinking out loud")).mentions).toEqual([]);
    await mock.idle();
    expect(seen.map((m) => m.author.type)).toEqual(["ba"]);
    await data.send("cv-brainstorm", "@QA thoughts?");
    await mock.idle();
    expect(seen.at(-1)).toMatchObject({ author: { type: "system" }, text: "@QA is not in this room." });
  });

  it("pages back through the history, oldest first", async () => {
    const data = createRoomsData(testMock());
    const last = await data.messages("cv-brainstorm", { limit: 2 });
    expect(last.messages.map((m) => m.id)).toEqual(["602", "603"]);
    expect(last.hasMore).toBe(true);
    expect(await data.messages("cv-brainstorm", { before: "602", limit: 2 })).toMatchObject({ messages: [{ id: "601" }], hasMore: false });
  });

  it("rejects an empty message (400) and creates group rooms (400 for a bad name)", async () => {
    const data = createRoomsData(testMock());
    expect(apiErrorInfo(await data.send("cv-brainstorm", "   ").catch((e: unknown) => e))).toMatchObject({ status: 400 });
    expect(await data.createRoom("salary-talk", ["qa"])).toMatchObject({ name: "salary-talk", kind: "group", members: ["qa"] });
    expect(apiErrorInfo(await data.createRoom("Bad Name", ["qa"]).catch((e: unknown) => e))).toMatchObject({ status: 400, code: "validation_failed" });
  });

  it("offers members and Lead for @mentions", () => {
    const bots = ["lead", "research", "cv"].map((name) => ({ name, displayName: name, role: "" }));
    expect(mentionableBots({ members: ["cv"] }, bots).map((b) => b.name)).toEqual(["lead", "cv"]);
  });

  it("live: posts to /api/chat/messages with the CSRF header", async () => {
    const calls: [string, RequestInit][] = [];
    const message = { id: "9", roomId: "3", author: { type: "ba" }, text: "@CV hi", mode: "discussion", mentions: ["cv"], runIds: [], uploadIds: [], cards: [], createdAt: "2026-10-11T03:00:00.000Z", attachments: [] };
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), init ?? {}]);
      return new Response(JSON.stringify({ message, taskIds: ["41"] }), { status: 201 });
    };
    const api = createHttpApi({ baseUrl: "/api", fetch: fetch as typeof globalThis.fetch, events: { subscribe: () => () => {}, getStatus: () => "idle", onStatus: () => () => {} } });
    expect((await createRoomsData(api).send("3", "@CV hi")).id).toBe("9");
    expect(calls[0]![0]).toBe("/api/chat/messages");
    expect(JSON.parse(String(calls[0]![1].body))).toEqual({ roomId: "3", text: "@CV hi", uploadIds: [] });
    expect(new Headers(calls[0]![1].headers).get(CSRF_HEADER)).toBe("1");
  });
});
