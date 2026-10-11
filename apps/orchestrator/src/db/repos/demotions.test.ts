// PM2 S8 (§5.3): demotion records the Bots screen reads (W3a BotView.demotion) and Ba's restore.
import { BotDemotionSchema } from "@bs-job-agents/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { openTestDb, type Db } from "../client.js";
import { mappers } from "../index.js";
import { at, seedBots, T0 } from "../test-helpers.js";
import { getBot, latestBotDemotion, listBotDemotions, recordBotDemotion, restoreBotDemotions, updateBot } from "./bots.js";

let db: Db;
beforeEach(() => {
  db = openTestDb();
  seedBots(db);
});

describe("bot demotions (PM2 S8)", () => {
  it("records a demotion with its reason; the latest open one is the Bots screen's", () => {
    const d = recordBotDemotion(db, { botName: "research", fromLevel: 2, toLevel: 1, reason: "off_allowlist", detail: "vietcombank.com.vn", taskId: null, runId: null }, { now: T0 });
    expect(d).toMatchObject({ botName: "research", fromLevel: 2, toLevel: 1, reason: "off_allowlist", restoredAt: null, createdAt: T0.toISOString() });
    expect(latestBotDemotion(db, "research")?.id).toBe(d.id);
    expect(latestBotDemotion(db, "cv")).toBeUndefined();
    expect(BotDemotionSchema.parse(mappers.toBotDemotion(d))).toMatchObject({ id: String(d.id), botName: "research", fromLevel: 2, toLevel: 1, reason: "off_allowlist", restoredAt: null });
  });

  it("raising the bot back to the level it had closes the demotion (Ba restores on the Bots screen)", () => {
    updateBot(db, "research", { trustLevel: 1 });
    recordBotDemotion(db, { botName: "research", fromLevel: 2, toLevel: 1, reason: "page_mismatch", detail: null, taskId: null, runId: null }, { now: T0 });
    updateBot(db, "research", { trustLevel: 2 });
    expect(latestBotDemotion(db, "research")).toBeUndefined();
    expect(listBotDemotions(db, "research")[0]!.restoredAt).not.toBeNull();
  });

  it("two demotions in a row: one restore closes only the one it undoes", () => {
    updateBot(db, "research", { trustLevel: 0 });
    recordBotDemotion(db, { botName: "research", fromLevel: 2, toLevel: 1, reason: "off_allowlist", detail: null, taskId: null, runId: null }, { now: T0 });
    recordBotDemotion(db, { botName: "research", fromLevel: 1, toLevel: 0, reason: "trust_level", detail: null, taskId: null, runId: null }, { now: at(60) });
    updateBot(db, "research", { trustLevel: 1 });
    expect(latestBotDemotion(db, "research")).toMatchObject({ fromLevel: 2, toLevel: 1 });
    expect(restoreBotDemotions(db, "research", 2, { now: at(120) })).toBe(1);
    expect(latestBotDemotion(db, "research")).toBeUndefined();
    expect(getBot(db, "research")?.trustLevel).toBe(1);
  });
});
