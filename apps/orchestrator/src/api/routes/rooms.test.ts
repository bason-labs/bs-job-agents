import { MessagesResponseSchema, RoomSchema, RoomsResponseSchema } from "@bs-job-agents/shared";
import { afterEach, describe, expect, it } from "vitest";
import { appendMessage, createUpload, getOrCreateLeadRoom } from "../../db/index.js";
import { createApiHarness, type ApiHarness } from "../testing.js";

let h: ApiHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

describe("rooms (UC-15) and room history", () => {
  it("lists the Lead chat, one consult thread per bot other than Lead (UC-25) and group rooms with their members", async () => {
    h = await createApiHarness();
    getOrCreateLeadRoom(h.t.db);
    const created = await h.post("/rooms", { name: "cv-brainstorm", members: ["qa", "cv"] });
    expect(created.statusCode).toBe(201);
    expect(RoomSchema.parse(created.json())).toMatchObject({ name: "cv-brainstorm", kind: "group", botName: null, members: ["cv", "qa"] });
    const rooms = RoomsResponseSchema.parse((await h.get("/rooms")).json()).rooms;
    expect(rooms.map((r) => [r.kind, r.botName, r.members])).toEqual([
      ["lead", "lead", ["lead"]],
      ["group", null, ["cv", "qa"]],
      ["direct", "apply", ["apply"]],
      ["direct", "cv", ["cv"]],
      ["direct", "qa", ["qa"]],
      ["direct", "research", ["research"]],
    ]);
    // Listing again creates nothing new.
    expect(RoomsResponseSchema.parse((await h.get("/rooms")).json()).rooms).toHaveLength(6);
  });

  it("refuses a taken name (409), an unknown bot (400) and a name that is not a slug (400)", async () => {
    h = await createApiHarness();
    expect((await h.post("/rooms", { name: "ideas", members: ["cv"] })).statusCode).toBe(201);
    expect((await h.post("/rooms", { name: "ideas", members: ["qa"] })).statusCode).toBe(409);
    expect((await h.post("/rooms", { name: "other", members: ["ghost"] })).statusCode).toBe(400);
    expect((await h.post("/rooms", { name: "Lead Chat", members: ["cv"] })).statusCode).toBe(400);
  });

  it("pages back through a room's messages, oldest first, with their attachments and cards", async () => {
    h = await createApiHarness();
    const room = getOrCreateLeadRoom(h.t.db);
    const upload = createUpload(h.t.db, { filename: "jd.pdf", mime: "application/pdf", size: 10, path: "uploads/x.pdf", sha256: "c".repeat(64) });
    const ids: number[] = [];
    for (let i = 1; i <= 5; i++) {
      ids.push(
        appendMessage(h.t.db, {
          roomId: room.id,
          author: i % 2 ? "ba" : "lead",
          text: `message ${i}`,
          uploadIds: i === 5 ? [upload.id] : [],
          meta: i === 4 ? { cards: [{ type: "run", runId: "7" }] } : null,
        }).id,
      );
    }
    const last = MessagesResponseSchema.parse((await h.get(`/rooms/${room.id}/messages?limit=2`)).json());
    expect(last.messages.map((m) => m.text)).toEqual(["message 4", "message 5"]);
    expect(last.hasMore).toBe(true);
    expect(last.messages[1]!.uploadIds).toEqual([String(upload.id)]);
    expect(last.messages[1]!.attachments).toEqual([
      { id: String(upload.id), filename: "jd.pdf", mime: "application/pdf", size: 10, file: { id: `upload-${upload.id}`, kind: "upload", filename: "jd.pdf", mime: "application/pdf" } },
    ]);
    expect(last.messages[0]!.cards).toEqual([{ type: "run", runId: "7" }]);
    expect(last.messages[0]!).toMatchObject({ author: { type: "bot", bot: "lead" }, mode: "work" });
    const earlier = MessagesResponseSchema.parse((await h.get(`/rooms/${room.id}/messages?before=${ids[3]}&limit=2`)).json());
    expect(earlier.messages.map((m) => m.text)).toEqual(["message 2", "message 3"]);
    const first = MessagesResponseSchema.parse((await h.get(`/rooms/${room.id}/messages?before=${ids[1]}`)).json());
    expect(first).toMatchObject({ hasMore: false });
    expect(first.messages.map((m) => m.text)).toEqual(["message 1"]);
    expect((await h.get(`/rooms/${room.id}/messages?limit=500`)).statusCode).toBe(400);
    expect((await h.get("/rooms/999/messages")).statusCode).toBe(404);
  });
});
