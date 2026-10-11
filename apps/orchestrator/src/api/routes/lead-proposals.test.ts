// PM3 M3 (UC-21b a "save to your criteria") and S1 (UC-21 schedules "by telling Lead"): Lead
// proposes in its structured output (it has no tool that saves), the orchestrator checks the
// proposal against the same rules as PUT /criteria and POST /schedules, stores it, and posts a
// card whose text it computes itself. Only Ba's click acts, and only on the stored proposal.
import {
  ApiErrorSchema,
  ChatSendResultSchema,
  MessagesResponseSchema,
  RoomsResponseSchema,
  type ChatMessage,
  type LeadOutput,
  type MessageCard,
} from "@bs-job-agents/shared";
import { leadCriteriaProposalFixture, leadScheduleProposalFixture } from "@bs-job-agents/shared/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { getActiveSearchProfile, listSchedules, listSearchProfileVersions, updateSearchProfile } from "../../db/index.js";
import { fake } from "../../engine/testing/index.js";
import { readApiState } from "../state.js";
import { createApiHarness, type ApiHarness } from "../testing.js";

let h: ApiHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

type Choice = Extract<MessageCard, { type: "choice" }>;

async function leadRoom(x: ApiHarness): Promise<string> {
  return RoomsResponseSchema.parse((await x.get("/rooms")).json()).rooms.find((r) => r.kind === "lead")!.id;
}

async function history(x: ApiHarness, room: string): Promise<ChatMessage[]> {
  return MessagesResponseSchema.parse((await x.get(`/rooms/${room}/messages`)).json()).messages;
}

/** Ba sends `text`; Lead answers with `output` once. Returns the room and the proposal card's message. */
async function propose(x: ApiHarness, output: LeadOutput, text = "Also include Đà Nẵng") {
  const room = await leadRoom(x);
  x.t.runner.script({ bot: "lead", kind: "chat", times: 1, result: fake.ok(output) });
  await x.post("/chat/messages", { roomId: room, text, uploadIds: [] });
  await x.t.idle();
  const messages = await history(x, room);
  const card = messages.find((m) => m.cards.some((c) => c.type === "choice"));
  const choice = card?.cards.find((c): c is Choice => c.type === "choice");
  return { room, messages, card, choice };
}

const versions = (x: ApiHarness) => listSearchProfileVersions(x.t.db, getActiveSearchProfile(x.t.db)!.name).length;

describe("propose_criteria_change → criteria-save:<id> (PM3 M3)", () => {
  it("posts a server-worded card; Save writes exactly one new version from the stored change, without Lead", async () => {
    h = await createApiHarness();
    const before = getActiveSearchProfile(h.t.db)!;
    const { messages, card, choice } = await propose(h, leadCriteriaProposalFixture);
    expect(messages.map((m) => m.author.type)).toEqual(["ba", "bot", "bot"]);
    expect(messages[1]!.text).toBe(leadCriteriaProposalFixture.reply);
    expect(card!.text).toBe(`Save to your search criteria (now v${before.version})? Add Đà Nẵng to locations.`);
    expect(choice!.key).toMatch(/^criteria-save:[A-Za-z0-9_-]{12,}$/);
    expect(choice!.options).toEqual([
      { id: "just_this_run", label: "Just this run" },
      { id: "save", label: "Save to my criteria" },
    ]);
    const leadCalls = h.t.runner.callsFor("lead.chat").length;

    const res = await h.post("/chat/choices", { messageId: card!.id, key: choice!.key, optionId: "save" });
    expect(res.statusCode).toBe(201);
    expect(ChatSendResultSchema.parse(res.json())).toMatchObject({ message: { text: "Save to my criteria", author: { type: "ba" } }, taskIds: [] });
    await h.t.idle();
    const after = getActiveSearchProfile(h.t.db)!;
    expect(after.version).toBe(before.version + 1);
    expect(versions(h)).toBe(before.version + 1);
    expect(after.locations).toEqual([...before.locations, "Đà Nẵng"]);
    expect(after.roles).toEqual(before.roles);
    expect(h.t.runner.callsFor("lead.chat")).toHaveLength(leadCalls);
    const all = await history(h, card!.roomId);
    expect(all.at(-1)).toMatchObject({ author: { type: "bot", bot: "lead" }, text: `Saved to your search criteria (now v${after.version}).` });
    expect(all.find((m) => m.id === card!.id)!.cards[0]).toMatchObject({ chosen: "save" });
    expect(Object.values(readApiState(h.dataDir).leadProposals)[0]).toMatchObject({ kind: "criteria", settledAt: expect.any(String), outcome: "save" });

    // Single use: a replay is a 409 and writes nothing.
    const replay = await h.post("/chat/choices", { messageId: card!.id, key: choice!.key, optionId: "save" });
    expect(replay.statusCode).toBe(409);
    expect(versions(h)).toBe(before.version + 1);
  });

  it("refuses a forged key (404) or option (400); nothing is saved", async () => {
    h = await createApiHarness();
    const v = versions(h);
    const { card, choice } = await propose(h, leadCriteriaProposalFixture);
    expect((await h.post("/chat/choices", { messageId: card!.id, key: "criteria-save:AAAAAAAAAAAAAAAA", optionId: "save" })).statusCode).toBe(404);
    expect((await h.post("/chat/choices", { messageId: card!.id, key: choice!.key, optionId: "save_all" })).statusCode).toBe(400);
    expect(versions(h)).toBe(v);
  });

  it("the click acts on the stored proposal, on top of Ba's newer edits (never Lead's text)", async () => {
    h = await createApiHarness();
    const { card, choice } = await propose(h, leadCriteriaProposalFixture);
    updateSearchProfile(h.t.db, { includeKeywords: ["Next.js"] });
    expect((await h.post("/chat/choices", { messageId: card!.id, key: choice!.key, optionId: "save" })).statusCode).toBe(201);
    expect(getActiveSearchProfile(h.t.db)).toMatchObject({ includeKeywords: ["Next.js"], locations: expect.arrayContaining(["Đà Nẵng"]) });
  });

  it("a change that no longer passes the criteria rules at click time is a 409; the card stays open", async () => {
    h = await createApiHarness();
    const only = getActiveSearchProfile(h.t.db)!.locations;
    const removeAll: LeadOutput = {
      ...leadCriteriaProposalFixture,
      actions: [{ type: "propose_criteria_change", changes: { ...(leadCriteriaProposalFixture.actions[0] as { changes: object }).changes, locations: { add: [], remove: [only[0]!] } } as never }],
    };
    updateSearchProfile(h.t.db, { locations: [...only, "Remote (VN)"] });
    const { card, choice } = await propose(h, removeAll);
    updateSearchProfile(h.t.db, { locations: only });
    const res = await h.post("/chat/choices", { messageId: card!.id, key: choice!.key, optionId: "save" });
    expect(res.statusCode).toBe(409);
    expect(ApiErrorSchema.parse(res.json()).error.message).toMatch(/at least one location/);
    expect((await history(h, card!.roomId)).find((m) => m.id === card!.id)!.cards[0]).toMatchObject({ chosen: null });
  });

  it("Just this run sends the label to Lead (per-run overrides) and saves nothing", async () => {
    h = await createApiHarness();
    const v = versions(h);
    const { card, choice } = await propose(h, leadCriteriaProposalFixture);
    const res = await h.post("/chat/choices", { messageId: card!.id, key: choice!.key, optionId: "just_this_run" });
    expect(res.statusCode).toBe(201);
    expect(ChatSendResultSchema.parse(res.json()).taskIds).toHaveLength(1);
    await h.t.idle();
    expect(h.t.runner.callsFor("lead.chat")).toHaveLength(2);
    expect(versions(h)).toBe(v);
    expect((await h.post("/chat/choices", { messageId: card!.id, key: choice!.key, optionId: "save" })).statusCode).toBe(409);
  });

  it("a proposal that fails validation, or changes nothing, never produces a card", async () => {
    h = await createApiHarness();
    const profile = getActiveSearchProfile(h.t.db)!;
    const base = (leadCriteriaProposalFixture.actions[0] as { changes: Record<string, unknown> }).changes;
    const invalid: LeadOutput = { ...leadCriteriaProposalFixture, actions: [{ type: "propose_criteria_change", changes: { ...base, locations: { add: [], remove: profile.locations } } as never }] };
    let r = await propose(h, invalid);
    expect(r.choice).toBeUndefined();
    expect(r.messages.at(-1)).toMatchObject({ author: { type: "system" }, text: expect.stringMatching(/^Lead suggested a change to your search criteria that can't be saved: .*at least one location/) });
    const noop: LeadOutput = { ...leadCriteriaProposalFixture, actions: [{ type: "propose_criteria_change", changes: { ...base, locations: { add: [profile.locations[0]!.toUpperCase()], remove: [] } } as never }] };
    r = await propose(h, noop);
    expect(r.choice).toBeUndefined();
    expect(Object.keys(readApiState(h.dataDir).leadProposals)).toHaveLength(0);
  });
});

describe("propose_schedule → schedule-create:<id> (PM3 S1, UC-21)", () => {
  it("posts the server's summary and next run; Create schedule creates it from the stored proposal", async () => {
    h = await createApiHarness();
    const { card, choice } = await propose(h, leadScheduleProposalFixture, "scan every weekday at 9");
    expect(choice!.key).toMatch(/^schedule-create:[A-Za-z0-9_-]{12,}$/);
    expect(choice!.options.map((o) => o.id)).toEqual(["not_now", "create"]);
    expect(card!.text).toMatch(/^Create the schedule “Weekday morning scan”\? Runs: Weekdays 09:00 · next run \w{3} \d{1,2} \w{3}, 09:00 · job scan with your active search criteria\.$/);
    expect(listSchedules(h.t.db)).toHaveLength(0);

    const res = await h.post("/chat/choices", { messageId: card!.id, key: choice!.key, optionId: "create" });
    expect(res.statusCode).toBe(201);
    const [row] = listSchedules(h.t.db);
    expect(row).toMatchObject({ name: "Weekday morning scan", cron: "0 9 * * 1-5", timezone: "Asia/Ho_Chi_Minh", workflowName: "job-scan", searchProfileId: null, enabled: true });
    expect(row!.nextRunAt).not.toBeNull();
    expect((await history(h, card!.roomId)).at(-1)!.text).toMatch(/^Created the schedule “Weekday morning scan” \(Weekdays 09:00\)\. Next run: /);
    expect(h.t.runner.callsFor("lead.chat")).toHaveLength(1);
    expect((await h.post("/chat/choices", { messageId: card!.id, key: choice!.key, optionId: "create" })).statusCode).toBe(409);
    expect(listSchedules(h.t.db)).toHaveLength(1);
  });

  it("Not now creates nothing and does not wake Lead", async () => {
    h = await createApiHarness();
    const { card, choice } = await propose(h, leadScheduleProposalFixture, "scan every weekday at 9");
    expect((await h.post("/chat/choices", { messageId: card!.id, key: choice!.key, optionId: "not_now" })).statusCode).toBe(201);
    expect(listSchedules(h.t.db)).toHaveLength(0);
    expect(h.t.runner.callsFor("lead.chat")).toHaveLength(1);
    expect((await history(h, card!.roomId)).at(-1)!.text).toBe("OK, no schedule was created.");
  });

  it("a schedule for a search profile that does not exist never produces a card", async () => {
    h = await createApiHarness();
    const bad: LeadOutput = { ...leadScheduleProposalFixture, actions: [{ type: "propose_schedule", schedule: { name: "x", repeat: "weekly", day: "Mon", time: "08:00", searchProfileId: "999" } }] };
    const { choice, messages } = await propose(h, bad, "scan on Mondays");
    expect(choice).toBeUndefined();
    expect(messages.at(-1)!.text).toMatch(/^Lead suggested a schedule that can't be created: searchProfileId/);
  });
});
