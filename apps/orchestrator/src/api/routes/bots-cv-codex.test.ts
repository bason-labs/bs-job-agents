// Owner decision 2026-10-11: Ba may switch CV to Codex as an explicit opt-in (to save Claude quota),
// accepting that the Figma guard hook (Claude-only PreToolUse) cannot run there. PATCH /bots/cv
// { engine: "codex" } needs acknowledgeRisk: true (409 otherwise) and stores the acknowledgement in
// bots.engine_risk_ack_at; Apply and Lead stay refused on Codex (403) whatever the flag says.
import { ApiErrorSchema, BotViewSchema, FIGMA_UNGUARDED_RISK } from "@bs-job-agents/shared";
import { afterEach, describe, expect, it } from "vitest";
import { getBot, openTestDb, updateBot } from "../../db/index.js";
import { seedBots } from "../../db/test-helpers.js";
import { staticBotRegistry } from "../../engine/testing/index.js";
import { unsafeStoredEngines } from "../boot/start.js";
import { createApiHarness, type ApiHarness } from "../testing.js";

let h: ApiHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const scan = { workflow: "job-scan", params: { searchProfileId: null, overrides: null } } as const;

describe("PATCH /bots/cv { engine: codex } (owner decision 2026-10-11)", () => {
  it("without acknowledgeRisk: 409 with the reason, nothing changes", async () => {
    h = await createApiHarness();
    for (const body of [{ engine: "codex" }, { engine: "codex", acknowledgeRisk: false }]) {
      const res = await h.patch("/bots/cv", body);
      expect(res.statusCode).toBe(409);
      const err = ApiErrorSchema.parse(res.json()).error;
      expect(err.code).toBe("conflict");
      expect(err.message).toMatch(/Figma guard/);
      expect(err.message).toMatch(/acknowledgeRisk/);
      expect(err.details).toMatchObject({ reason: "risk_not_acknowledged", risk: FIGMA_UNGUARDED_RISK });
    }
    expect(getBot(h.t.db, "cv")).toMatchObject({ engine: "claude", engineRiskAckAt: null });
    expect(h.t.events("bot.updated")).toHaveLength(0);
  });

  it("with acknowledgeRisk: 200, the acknowledgement is stored, the view says the Figma guard is off", async () => {
    h = await createApiHarness();
    const res = await h.patch("/bots/cv", { engine: "codex", acknowledgeRisk: true });
    expect(res.statusCode).toBe(200);
    const now = h.t.clock.now().toISOString();
    const view = BotViewSchema.parse(res.json());
    expect(view).toMatchObject({ engine: "codex", figmaGuardOff: true, engineRiskAcknowledgedAt: now });
    expect(view.residualRisk).toMatch(/Figma guard/);
    expect(getBot(h.t.db, "cv")).toMatchObject({ engine: "codex", engineRiskAckAt: now });
    expect(h.t.events("bot.updated").at(-1)).toMatchObject({ botName: "cv", engine: "codex" });
    h.t.checkEvents();
  });

  it("switching back to Claude keeps the record; every new switch to Codex asks again", async () => {
    h = await createApiHarness();
    await h.patch("/bots/cv", { engine: "codex", acknowledgeRisk: true });
    const at = getBot(h.t.db, "cv")!.engineRiskAckAt;
    const back = BotViewSchema.parse((await h.patch("/bots/cv", { engine: "claude" })).json());
    expect(back).toMatchObject({ engine: "claude", figmaGuardOff: false, residualRisk: null, engineRiskAcknowledgedAt: at });
    expect((await h.patch("/bots/cv", { engine: "codex" })).statusCode).toBe(409);
    expect(getBot(h.t.db, "cv")!.engine).toBe("claude");
  });

  it("acknowledgeRisk never unlocks Apply or Lead (403, their own reasons)", async () => {
    h = await createApiHarness();
    const apply = await h.patch("/bots/apply", { engine: "codex", acknowledgeRisk: true });
    expect(apply.statusCode).toBe(403);
    expect(ApiErrorSchema.parse(apply.json()).error.message).toMatch(/browser bot that writes must run on Claude/);
    const lead = await h.patch("/bots/lead", { engine: "codex", acknowledgeRisk: true });
    expect(lead.statusCode).toBe(403);
    expect(ApiErrorSchema.parse(lead.json()).error.message).toBe("lead: Lead must run on Claude, where its only tools are the orchestrator's (rule 5)");
    expect(getBot(h.t.db, "apply")).toMatchObject({ engine: "claude", engineRiskAckAt: null });
    expect(getBot(h.t.db, "lead")).toMatchObject({ engine: "claude", engineRiskAckAt: null });
  });

  it("Research and QA switch as before, with or without the flag (nothing to acknowledge)", async () => {
    h = await createApiHarness();
    expect((await h.patch("/bots/qa", { engine: "claude" })).statusCode).toBe(200);
    expect((await h.patch("/bots/research", { engine: "claude", acknowledgeRisk: true })).statusCode).toBe(200);
    expect(getBot(h.t.db, "research")!.engineRiskAckAt).toBeNull();
  });

  it("the next CV task runs on Codex with the opt-in, without hook settings", async () => {
    h = await createApiHarness();
    await h.patch("/bots/cv", { engine: "codex", acknowledgeRisk: true });
    await h.post("/runs", scan);
    await h.t.idle();
    const call = h.t.runner.callsFor("cv.tailor")[0]!;
    expect(call).toMatchObject({ bot: expect.objectContaining({ engine: "codex" }), unguardedFigmaAcknowledged: true });
    expect(call.hookSettings).toBeUndefined();
  });
});

describe("start-up check of stored engines (PM3 M1) with Ba's opt-in", () => {
  it("CV stored on Codex is refused without the acknowledgement and accepted with it; Lead never", () => {
    const db = openTestDb();
    seedBots(db);
    const registry = staticBotRegistry();
    updateBot(db, "cv", { engine: "codex" });
    expect(unsafeStoredEngines(db, registry)).toMatch(/Figma bridge must run on Claude/);
    updateBot(db, "cv", { engineRiskAckAt: "2026-10-11T09:00:00.000Z" });
    expect(unsafeStoredEngines(db, registry)).toBeNull();
    updateBot(db, "lead", { engine: "codex", engineRiskAckAt: "2026-10-11T09:00:00.000Z" });
    expect(unsafeStoredEngines(db, registry)).toMatch(/Lead must run on Claude/);
  });
});
