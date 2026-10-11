// Live run 1: Ba picks a bot's model on the Bots screen (PATCH /bots/:name { model }). The model must
// suit the bot's engine (runner/model.ts: a Claude model never goes to Codex and vice versa); null
// goes back to bot.json's model. The choice survives a restart (start-up sync keeps it) and the
// next task's runner gets it. (Test fixtures: CV and Lead on Claude, Research and QA on Codex, no
// bot.json model.)
import { ApiErrorSchema, BotViewSchema } from "@bs-job-agents/shared";
import { afterEach, describe, expect, it } from "vitest";
import { getBot, syncBotFromDefinition } from "../../db/index.js";
import { createApiHarness, type ApiHarness } from "../testing.js";

let h: ApiHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

describe("PATCH /bots/:name { model }", () => {
  it("sets a model that suits the engine; the view shows it with bot.json's default; null goes back to the default", async () => {
    h = await createApiHarness();
    const res = await h.patch("/bots/cv", { model: "opus" });
    expect(res.statusCode).toBe(200);
    expect(BotViewSchema.parse(res.json())).toMatchObject({ model: "opus", defaultModel: null });
    expect(h.t.events("bot.updated").at(-1)).toMatchObject({ botName: "cv" });
    expect(BotViewSchema.parse((await h.get("/bots/cv")).json())).toMatchObject({ model: "opus" });
    const back = BotViewSchema.parse((await h.patch("/bots/cv", { model: null })).json());
    expect(back).toMatchObject({ model: null, defaultModel: null });
  });

  it("refuses a model for the other engine (400), and a malformed name", async () => {
    h = await createApiHarness();
    for (const [bot, model] of [
      ["cv", "gpt-5"],
      ["cv", "o3"],
      ["qa", "sonnet"],
      ["research", "claude-opus-4-1"],
    ] as const) {
      const res = await h.patch(`/bots/${bot}`, { model });
      expect(res.statusCode, `${bot} ${model}`).toBe(400);
      expect(ApiErrorSchema.parse(res.json()).error.code).toBe("validation_failed");
    }
    expect((await h.patch("/bots/cv", { model: "--dangerously-skip-permissions" })).statusCode).toBe(400);
    expect((await h.patch("/bots/cv", { model: "" })).statusCode).toBe(400);
    expect((await h.patch("/bots/cv", { model: "a b" })).statusCode).toBe(400);
    expect((await h.patch("/bots/qa", { model: "gpt-5-codex" })).statusCode).toBe(200);
    expect(getBot(h.t.db, "cv")?.modelOverride ?? null).toBeNull();
  });

  it("an engine switch drops a model that no longer suits it; model and engine together are checked against the new engine", async () => {
    h = await createApiHarness();
    expect((await h.patch("/bots/research", { model: "gpt-5-codex" })).statusCode).toBe(200);
    const view = BotViewSchema.parse((await h.patch("/bots/research", { engine: "claude" })).json());
    expect(view).toMatchObject({ engine: "claude", model: null });
    expect((await h.patch("/bots/research", { engine: "codex", model: "sonnet" })).statusCode).toBe(400);
    expect(BotViewSchema.parse((await h.patch("/bots/research", { engine: "codex", model: "o3" })).json())).toMatchObject({ engine: "codex", model: "o3" });
  });

  it("the choice survives the start-up sync from bot.json, and the next task runs with it", async () => {
    h = await createApiHarness();
    await h.patch("/bots/qa", { model: "o3" });
    const def = h.t.engine.deps.bots.get("qa")!;
    syncBotFromDefinition(h.t.db, { name: "qa", displayName: def.displayName, engine: def.engine, trustLevel: def.trustLevel, model: def.model, promptVersion: def.promptVersion, enabled: def.enabled });
    expect(getBot(h.t.db, "qa")).toMatchObject({ model: def.model, modelOverride: "o3" });
    await h.post("/runs", { workflow: "job-scan", params: { searchProfileId: null, overrides: null } });
    await h.t.idle();
    expect(h.t.runner.callsFor("qa.review")[0]!.bot.model).toBe("o3");
    expect(h.t.runner.callsFor("cv.tailor")[0]!.bot.model).toBeNull();
  });
});
