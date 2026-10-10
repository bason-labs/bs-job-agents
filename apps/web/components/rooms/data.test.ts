import { MessageSchema, RoomSchema } from "@bs-job-agents/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFixtureRoomsData } from "./data";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("fixture rooms store (UC-15)", () => {
  it("has the prototype's #cv-brainstorm room and conversation", async () => {
    const data = createFixtureRoomsData();
    const room = RoomSchema.parse(await data.getRoom("cv-brainstorm"));
    expect(room).toMatchObject({ kind: "group", members: ["lead", "research", "cv", "qa", "apply"] });
    const messages = await data.messages("cv-brainstorm");
    expect(messages.map((m) => (m.author.type === "bot" ? m.author.bot : m.author.type))).toEqual(["ba", "cv", "qa"]);
    for (const m of messages) expect(() => MessageSchema.parse(m)).not.toThrow();
    expect(await data.getRoom("nope")).toBeNull();
  });

  it("posts Ba's message with its mentions, and each mentioned bot answers in turn", async () => {
    const data = createFixtureRoomsData({ replyDelayMs: 100 });
    const replies: string[] = [];
    data.subscribe("cv-brainstorm", (m) => m.author.type === "bot" && replies.push(m.author.bot));
    const mine = await data.send("cv-brainstorm", "@Research @Apply what do you think?");
    expect(mine).toMatchObject({ author: { type: "ba" }, mentions: ["research", "apply"], mode: "discussion" });
    await vi.advanceTimersByTimeAsync(100);
    expect(replies).toEqual(["research"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(replies).toEqual(["research", "apply"]);
    expect((await data.messages("cv-brainstorm")).at(-1)!.text).toMatch(/discussion mode/);
  });

  it("sends a message without a mention to no bot", async () => {
    const data = createFixtureRoomsData({ replyDelayMs: 10 });
    const seen = vi.fn();
    data.subscribe("cv-brainstorm", seen);
    expect((await data.send("cv-brainstorm", "just thinking out loud")).mentions).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).not.toHaveBeenCalled();
  });

  it("rejects an empty message", async () => {
    await expect(createFixtureRoomsData().send("cv-brainstorm", "   ")).rejects.toThrow();
  });
});
