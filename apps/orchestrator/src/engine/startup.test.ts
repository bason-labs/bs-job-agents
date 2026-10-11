// Start-up on a fresh database (QA Phase 2). Production has no seedBots(): the `bots` table must
// be filled from bot.json, or every row that references a bot (the Lead room, memory_changes,
// prompt_versions) fails its foreign key. And the PM brief for W2b: at start-up, ROLE.md's hash is
// compared with the stored prompt_versions row of the same version; a changed ROLE.md without a
// promptVersion bump refuses to start (sub-project C needs every prompt's text, §1.3, §9).
import { botDefinitionFixtures } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import {
  appendMemoryChange,
  createSchedule,
  createSearchProfile,
  getPromptVersion,
  listBots,
  listMemoryChanges,
  listMessages,
  getOrCreateLeadRoom,
  openTestDb,
  updateBot,
} from "../db/index.js";
import { rolePromptHash } from "../runner/index.js";
import { FakeClock } from "./testing/fake-clock.js";
import { createTestEngine } from "./testing/harness.js";

const T0 = new Date("2026-10-10T08:00:00.000Z");

describe("the bots table follows bot.json at start-up", () => {
  it("a fresh database gets every bot, so the Lead room, memory notes and schedules work", async () => {
    const db = openTestDb();
    const t = await createTestEngine({ db, clock: new FakeClock(T0) });
    expect(listBots(db).map((b) => [b.name, b.engine, b.trustLevel])).toEqual([
      ["apply", "claude", 1],
      ["cv", "claude", 2],
      ["lead", "claude", 1],
      ["qa", "codex", 2],
      ["research", "codex", 2],
    ]);
    createSearchProfile(db, { roles: ["Frontend Engineer"], locations: ["Ho Chi Minh City"], sources: ["itviec"] });
    createSchedule(db, { name: "Weekday scan", cron: "0 9 * * 1-5", workflowName: "job-scan", searchProfileId: null, timezone: "Asia/Ho_Chi_Minh", nextRunAt: T0.toISOString() });
    expect(t.engine.scheduler.tick()).toMatchObject({ fired: [expect.objectContaining({ runId: 1 })], skipped: [] });
    await t.idle();
    // UC-02: Lead's "Scheduled scan started" message, then the summary when the card is ready (the
    // Lead room references the lead bot).
    expect(listMessages(db, getOrCreateLeadRoom(db).id).map((m) => m.text)).toEqual([expect.stringMatching(/^Scheduled scan started/), expect.stringMatching(/^🎯 1 job ready for review/)]);
    // Rule 2: memory_changes reference the bot too (the production smoke test runs the writer).
    appendMemoryChange(db, { botName: "research", note: "TopCV upload limit is 5MB" });
    expect(listMemoryChanges(db, "research")).toHaveLength(1);
  });

  it("keeps what Ba changed on the Bots screen (engine, trust level, enabled); bot.json owns the name and prompt version", async () => {
    const db = openTestDb();
    await createTestEngine({ db, clock: new FakeClock(T0) });
    updateBot(db, "research", { engine: "claude", trustLevel: 1, enabled: false, displayName: "Old name", promptVersion: 9 });
    await createTestEngine({ db, clock: new FakeClock(T0) });
    const research = listBots(db).find((b) => b.name === "research")!;
    expect(research).toMatchObject({ engine: "claude", trustLevel: 1, enabled: false, displayName: "Research", promptVersion: 1 });
  });
});

describe("prompt versions (§9 prompt_versions, PM brief W2b)", () => {
  const roles: Record<string, string> = Object.fromEntries(botDefinitionFixtures.map((d) => [d.name, `You are ${d.name}.\n`]));
  const source = (over: Record<string, string> = {}) => ({ roleMd: (name: string) => over[name] ?? roles[name]! });

  it("records each bot's ROLE.md text and hash for its prompt version", async () => {
    const db = openTestDb();
    await createTestEngine({ db, clock: new FakeClock(T0), prompts: source() });
    expect(getPromptVersion(db, "cv", 1)).toMatchObject({ roleMdText: "You are cv.\n", roleMdHash: rolePromptHash("You are cv.\n") });
    // The same text again: nothing changes, the start goes on.
    await createTestEngine({ db, clock: new FakeClock(T0), prompts: source() });
  });

  it("refuses to start when ROLE.md changed but promptVersion was not bumped", async () => {
    const db = openTestDb();
    await createTestEngine({ db, clock: new FakeClock(T0), prompts: source() });
    await expect(createTestEngine({ db, clock: new FakeClock(T0), prompts: source({ qa: "You are a stricter qa.\n" }) })).rejects.toThrow(
      /bots\/qa\/ROLE\.md changed.*bump promptVersion/,
    );
  });

  it("a bumped promptVersion records the new text next to the old one", async () => {
    const db = openTestDb();
    await createTestEngine({ db, clock: new FakeClock(T0), prompts: source() });
    const bumped = botDefinitionFixtures.map((d) => (d.name === "qa" ? { ...d, promptVersion: 2 } : d));
    await createTestEngine({ db, clock: new FakeClock(T0), prompts: source({ qa: "You are a stricter qa.\n" }), bots: bumped });
    expect(getPromptVersion(db, "qa", 1)?.roleMdText).toBe("You are qa.\n");
    expect(getPromptVersion(db, "qa", 2)?.roleMdText).toBe("You are a stricter qa.\n");
  });
});

describe("bot memory files (PM2 S5)", () => {
  it("start-up asks the memory writer to seed every bot's memory.md (it is gitignored, so a fresh clone has none)", async () => {
    const seeded: string[][] = [];
    const memory = { append: async () => undefined, seed: async (names: readonly string[]) => void seeded.push([...names]) };
    await createTestEngine({ db: openTestDb(), clock: new FakeClock(T0), memory });
    expect(seeded).toEqual([["apply", "cv", "lead", "qa", "research"]]);
  });

  it("a failing seed never stops the start-up", async () => {
    const memory = { append: async () => undefined, seed: async () => Promise.reject(new Error("read-only disk")) };
    await expect(createTestEngine({ db: openTestDb(), clock: new FakeClock(T0), memory })).resolves.toBeDefined();
  });
});
