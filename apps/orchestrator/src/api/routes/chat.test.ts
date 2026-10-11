// PM2 S20: chat flows on F2's conversation seam (UC-01, UC-15, UC-24, UC-25), end to end through
// the API with the FakeRunner engine.
import { ChatSendResultSchema, MessagesResponseSchema, RoomsResponseSchema, type ChatMessage, type LeadChatInput, type Room } from "@bs-job-agents/shared";
import { consultHandoffFixture, leadClarifyFixture } from "@bs-job-agents/shared/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { createUpload, getOrCreateLeadRoom, getRun, getUpload, listRuns, updateBot } from "../../db/index.js";
import { defaultFakeResult, fake } from "../../engine/testing/index.js";
import { createApiHarness, type ApiHarness } from "../testing.js";

let h: ApiHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function rooms(x: ApiHarness): Promise<Room[]> {
  return RoomsResponseSchema.parse((await x.get("/rooms")).json()).rooms;
}

async function roomId(x: ApiHarness, kind: Room["kind"], botName?: string): Promise<string> {
  const room = (await rooms(x)).find((r) => r.kind === kind && (botName === undefined || r.botName === botName));
  return room!.id;
}

async function history(x: ApiHarness, id: string): Promise<ChatMessage[]> {
  return MessagesResponseSchema.parse((await x.get(`/rooms/${id}/messages`)).json()).messages;
}

async function send(x: ApiHarness, id: string, text: string, uploadIds: string[] = []) {
  const res = await x.post("/chat/messages", { roomId: id, text, uploadIds });
  return res;
}

describe("POST /chat/messages in the Lead chat (UC-01, rule 1)", () => {
  it("stores Ba's message, queues lead.chat with the untrusted history, and posts Lead's reply", async () => {
    h = await createApiHarness();
    const lead = await roomId(h, "lead");
    await send(h, lead, "hello");
    await h.t.idle();
    const res = await send(h, lead, "Find frontend jobs in HCM");
    expect(res.statusCode).toBe(201);
    const body = ChatSendResultSchema.parse(res.json());
    expect(body.message).toMatchObject({ text: "Find frontend jobs in HCM", author: { type: "ba" }, mode: "work", attachments: [] });
    expect(body.taskIds).toHaveLength(1);
    await h.t.idle();
    const call = h.t.runner.callsFor("lead.chat").at(-1)!;
    const input = call.input as LeadChatInput;
    expect(input).toMatchObject({ roomId: lead, messageId: body.message.id, text: "Find frontend jobs in HCM", handoff: null, uploadIds: [] });
    expect(input.history.map((m) => m.author)).toEqual(["Ba", "lead"]);
    const messages = await history(h, lead);
    expect(messages.at(-1)).toMatchObject({ author: { type: "bot", bot: "lead" }, mode: "work" });
    expect(h.t.events("message.created").map((e) => e.message.author.type)).toEqual(["ba", "bot", "ba", "bot"]);
  });

  it("builds the delegation trace and run card from what Lead did through its tools, never from ids it wrote", async () => {
    h = await createApiHarness();
    const x = h;
    const lead = await roomId(x, "lead");
    // The fixture claims run_13; Lead's tools actually started run 1.
    x.t.runner.script({
      bot: "lead",
      kind: "chat",
      result: (task) => {
        const r = x.t.engine.lead.startWorkflow({ botName: "lead", mode: "work" }, { workflow: "job-scan", params: { searchProfileId: null, overrides: null } });
        if (r.started) x.capabilities.record(task.taskId, { type: "start_workflow", workflow: "job-scan", runId: r.runId });
        return defaultFakeResult(task);
      },
    });
    await send(x, lead, "Find frontend jobs in HCM");
    await x.t.idle();
    const reply = (await history(x, lead)).find((m) => m.author.type === "bot" && m.cards.some((c) => c.type === "run"))!;
    expect(reply.runIds).toEqual(["1"]);
    expect(reply.cards).toEqual([
      { type: "delegation", bot: "research", task: "@Research: scan 3 sources · running", status: "running" },
      { type: "run", runId: "1" },
    ]);
    expect(getRun(x.t.db, 1)?.trigger).toBe("chat");
  });

  it("a clarifying question offers its choices as chips; picking one answers Lead in the same chat (UC-01 a)", async () => {
    h = await createApiHarness();
    const lead = await roomId(h, "lead");
    h.t.runner.script({ bot: "lead", kind: "chat", times: 1, result: fake.ok(leadClarifyFixture) });
    await send(h, lead, "Find jobs");
    await h.t.idle();
    const question = (await history(h, lead)).at(-1)!;
    const choice = question.cards.find((c) => c.type === "choice");
    expect(choice).toMatchObject({ key: "ask_user", chosen: null });
    const option = (choice as { options: { id: string; label: string }[] }).options[0]!;
    const res = await h.post("/chat/choices", { messageId: question.id, key: "ask_user", optionId: option.id });
    expect(res.statusCode).toBe(201);
    expect(ChatSendResultSchema.parse(res.json()).message.text).toBe(option.label);
    await h.t.idle();
    expect(h.t.runner.callsFor("lead.chat")).toHaveLength(2);
    const updated = (await history(h, lead)).find((m) => m.id === question.id)!;
    expect(updated.cards.find((c) => c.type === "choice")).toMatchObject({ chosen: option.id });
    expect((await h.post("/chat/choices", { messageId: question.id, key: "ask_user", optionId: option.id })).statusCode).toBe(409);
    expect((await h.post("/chat/choices", { messageId: question.id, key: "nope", optionId: "1" })).statusCode).toBe(404);
  });

  it("links uploads to Ba's message (UC-24) and tells Lead what was attached, in the untrusted history", async () => {
    h = await createApiHarness();
    const lead = await roomId(h, "lead");
    const upload = createUpload(h.t.db, { filename: "NovaPay JD.pdf", mime: "application/pdf", size: 1234, path: "uploads/x.pdf", sha256: "d".repeat(64) });
    const res = await send(h, lead, "", [String(upload.id)]);
    expect(res.statusCode).toBe(201);
    const body = ChatSendResultSchema.parse(res.json());
    expect(body.message.uploadIds).toEqual([String(upload.id)]);
    expect(body.message.attachments?.[0]).toMatchObject({ filename: "NovaPay JD.pdf", file: { id: `upload-${upload.id}`, kind: "upload" } });
    expect(getUpload(h.t.db, upload.id)?.messageId).toBe(Number(body.message.id));
    await h.t.idle();
    const input = h.t.runner.callsFor("lead.chat")[0]!.input as LeadChatInput;
    expect(input.uploadIds).toEqual([String(upload.id)]);
    expect(input.history.at(-1)).toEqual({ author: "system", text: `Ba attached upload ${upload.id}: NovaPay JD.pdf (application/pdf, 1234 bytes)` });
    // F8: the live event carries the attachment too (the chip shows its name and opens by mime).
    const created = h.t.events("message.created").find((e) => e.message.id === body.message.id)!;
    expect(created.message.attachments).toEqual([
      { id: String(upload.id), filename: "NovaPay JD.pdf", mime: "application/pdf", size: 1234, file: { id: `upload-${upload.id}`, kind: "upload", filename: "NovaPay JD.pdf", mime: "application/pdf" } },
    ]);
    expect(h.t.events("message.created").find((e) => e.message.author.type !== "ba")?.message.attachments).toBeUndefined();
    // An upload belongs to one message; an unknown one is refused.
    expect((await send(h, lead, "again", [String(upload.id)])).statusCode).toBe(409);
    expect((await send(h, lead, "ghost", ["999"])).statusCode).toBe(400);
  });

  it("validates the body: no text and no file (400), an unknown room (404); 503 when degraded", async () => {
    h = await createApiHarness();
    const lead = await roomId(h, "lead");
    expect((await send(h, lead, "   ")).statusCode).toBe(400);
    expect((await send(h, "999", "hi")).statusCode).toBe(404);
    await h.close();
    h = await createApiHarness({ state: { state: "degraded", reason: "engine_start_failed", detail: "x", startedAt: "2026-10-10T08:00:00.000Z" } });
    getOrCreateLeadRoom(h.t.db);
    expect((await send(h, "1", "hi")).statusCode).toBe(503);
  });

  it("a conversation that fails for good gets a plain note from the bot, no internals", async () => {
    h = await createApiHarness();
    const lead = await roomId(h, "lead");
    h.t.runner.script({ bot: "lead", kind: "chat", result: fake.failed("spawn /Users/ba/.local/bin/claude ENOENT") });
    await send(h, lead, "hi");
    await h.t.idle();
    const note = (await history(h, lead)).at(-1)!;
    expect(note.author).toEqual({ type: "bot", bot: "lead" });
    expect(note.text).toMatch(/could not answer/);
    expect(note.text).not.toMatch(/Users|ENOENT/);
  });

  it("PM3 M1: Lead stored on Codex is refused at spawn (never runs) and Ba gets a clear note", async () => {
    h = await createApiHarness();
    const lead = await roomId(h, "lead");
    updateBot(h.t.db, "lead", { engine: "codex" });
    await send(h, lead, "Find frontend jobs in HCM");
    await h.t.idle();
    expect(h.t.runner.callsFor("lead.chat")).toHaveLength(0);
    expect(h.t.events("safety.denied").at(-1)).toMatchObject({ botName: "lead", reason: "trust_level" });
    const note = (await history(h, lead)).at(-1)!;
    expect(note.text).toBe("Lead runs only on Claude, where its only tools are the orchestrator's (rule 5), but it is set to another engine. Switch Lead back to Claude on the Bots screen, then send your message again.");
  });
});

describe("consult threads (UC-25)", () => {
  it("a direct thread asks the bot in consult mode; its answer appears in the thread and no work starts", async () => {
    h = await createApiHarness();
    const qa = await roomId(h, "direct", "qa");
    const res = await send(h, qa, "Why did QA fail NovaPay?");
    expect(ChatSendResultSchema.parse(res.json()).message.mode).toBe("consult");
    await h.t.idle();
    expect(h.t.runner.callsFor("qa.consult")).toHaveLength(1);
    expect((await history(h, qa)).at(-1)).toMatchObject({ author: { type: "bot", bot: "qa" }, mode: "consult", cards: [] });
    expect(h.t.runner.callsFor("lead.chat")).toEqual([]);
    expect(listRuns(h.t.db)).toEqual([]);
  });

  it("a work request is handed to Lead: handoff card in the thread, 'Handed over from @QA' and a lead.chat task in the Lead chat", async () => {
    h = await createApiHarness();
    const qa = await roomId(h, "direct", "qa");
    const lead = await roomId(h, "lead");
    h.t.runner.script({ bot: "qa", kind: "consult", result: fake.ok(consultHandoffFixture) });
    await send(h, qa, "Find me AI frontend jobs");
    await h.t.idle();
    const reply = (await history(h, qa)).at(-1)!;
    expect(reply.cards).toEqual([{ type: "handoff", fromBot: "qa", request: "Find AI-focused frontend roles in HCM" }]);
    const leadMessages = await history(h, lead);
    expect(leadMessages[0]).toMatchObject({ author: { type: "system" }, text: "Handed over from @QA: Find AI-focused frontend roles in HCM" });
    const call = h.t.runner.callsFor("lead.chat")[0]!;
    expect(call.input).toMatchObject({ roomId: lead, messageId: leadMessages[0]!.id, text: "Find me AI frontend jobs", handoff: { fromBot: "qa", request: "Find AI-focused frontend roles in HCM" } });
    expect(leadMessages.at(-1)).toMatchObject({ author: { type: "bot", bot: "lead" } });
    // Consult never did the work itself.
    expect(h.t.runner.callsFor("qa.consult")).toHaveLength(1);
  });

  it("when Lead is disabled the handoff is noted instead of failing the consult reply", async () => {
    h = await createApiHarness();
    const qa = await roomId(h, "direct", "qa");
    const lead = await roomId(h, "lead");
    updateBot(h.t.db, "lead", { enabled: false });
    h.t.runner.script({ bot: "qa", kind: "consult", result: fake.ok(consultHandoffFixture) });
    await send(h, qa, "Find me AI frontend jobs");
    await h.t.idle();
    expect((await history(h, qa)).at(-1)!.cards[0]).toMatchObject({ type: "handoff" });
    expect((await history(h, lead)).map((m) => m.text)).toEqual(["Handed over from @QA: Find AI-focused frontend roles in HCM", "The request from @QA was not planned: Lead is disabled on the Bots screen."]);
    expect(h.t.runner.callsFor("lead.chat")).toEqual([]);
  });

  it("a disabled bot does not answer: Ba's message stays with a note", async () => {
    h = await createApiHarness();
    const cv = await roomId(h, "direct", "cv");
    updateBot(h.t.db, "cv", { enabled: false });
    const res = await send(h, cv, "Which template fits AI startups?");
    expect(res.statusCode).toBe(201);
    expect(ChatSendResultSchema.parse(res.json()).taskIds).toEqual([]);
    expect((await history(h, cv)).at(-1)!.text).toMatch(/@CV will not answer/);
  });
});

describe("group rooms with @mentions (UC-15)", () => {
  it("each mentioned member answers in discussion mode; no mention → no bot; a non-member is noted", async () => {
    h = await createApiHarness();
    const created = await h.post("/rooms", { name: "cv-brainstorm", members: ["cv", "qa"] });
    const room = created.json().id as string;
    const first = ChatSendResultSchema.parse((await send(h, room, "@CV @QA how should I present the AI lab work?")).json());
    expect(first.message.mentions).toEqual(["cv", "qa"]);
    expect(first.taskIds).toHaveLength(2);
    await h.t.idle();
    expect(h.t.runner.callsFor("cv.discussion")).toHaveLength(1);
    expect(h.t.runner.callsFor("qa.discussion")).toHaveLength(1);
    const replies = (await history(h, room)).filter((m) => m.author.type === "bot");
    expect(replies.map((m) => [m.author, m.mode]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual([
      [{ type: "bot", bot: "cv" }, "discussion"],
      [{ type: "bot", bot: "qa" }, "discussion"],
    ]);
    expect(ChatSendResultSchema.parse((await send(h, room, "just thinking out loud")).json()).taskIds).toEqual([]);
    const outsider = ChatSendResultSchema.parse((await send(h, room, "@Apply what do you think?")).json());
    expect(outsider.taskIds).toEqual([]);
    expect((await history(h, room)).at(-1)!.text).toBe("@Apply is not in this room.");
    expect(listRuns(h.t.db)).toEqual([]);
  });

  it("@Lead in a room turns the discussion into work through Lead's chat (UC-15: \"@Lead turn this into a task\")", async () => {
    h = await createApiHarness();
    const room = (await h.post("/rooms", { name: "ideas", members: ["cv"] })).json().id as string;
    await send(h, room, "@Lead turn this into a task");
    await h.t.idle();
    const call = h.t.runner.callsFor("lead.chat")[0]!;
    expect(call.input).toMatchObject({ roomId: room, handoff: null });
    expect((await history(h, room)).at(-1)).toMatchObject({ author: { type: "bot", bot: "lead" } });
  });
});
