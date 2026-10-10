import { BotViewSchema } from "@bs-job-agents/shared";
import { describe, expect, it } from "vitest";
import { apiErrorInfo } from "@/components/schedules/apiError";
import { createFixtureBotsData } from "./data";
import { BOT_VIEWS } from "./fixtures";

describe("bot fixtures", () => {
  it("are valid BotViews for the five Phase 1 bots", () => {
    expect(BOT_VIEWS.map((b) => b.name)).toEqual(["lead", "research", "cv", "qa", "apply"]);
    for (const b of BOT_VIEWS) expect(() => BotViewSchema.parse(b)).not.toThrow();
  });

  it("match the prototype: Apply L1 with a promotion suggestion it can't accept, Research with its residual risk", () => {
    const apply = BOT_VIEWS.find((b) => b.name === "apply")!;
    expect(apply).toMatchObject({ trustLevel: 1, engine: "claude", promotionSuggested: true, promoteAllowed: false });
    expect(BOT_VIEWS.find((b) => b.name === "research")!.residualRisk).toMatch(/prompt/);
  });
});

describe("fixture bots store (PM S21 rules)", () => {
  it("switches an unlocked bot's engine", async () => {
    const data = createFixtureBotsData();
    expect((await data.update("research", { engine: "claude" })).engine).toBe("claude");
  });

  it("refuses Apply or CV on Codex with the API's 403", async () => {
    const data = createFixtureBotsData();
    const refused = await data.update("apply", { engine: "codex" }).catch((e: unknown) => e);
    expect(apiErrorInfo(refused)).toMatchObject({ status: 403, code: "forbidden" });
    await expect(data.update("cv", { engine: "codex" })).rejects.toThrow(/Figma/);
  });

  it("raises one level at a time up to the Phase 1 cap; Apply stays L1 (403)", async () => {
    const data = createFixtureBotsData();
    expect(apiErrorInfo(await data.update("apply", { trustLevel: 2 }).catch((e: unknown) => e))).toMatchObject({ status: 403, message: expect.stringMatching(/Apply stays at L1/) });
    expect((await data.update("lead", { trustLevel: 2 })).trustLevel).toBe(2);
    const lead = await data.update("lead", { trustLevel: 0 }); // lowering is always allowed
    expect(lead).toMatchObject({ trustLevel: 0, promoteAllowed: true });
    expect(apiErrorInfo(await data.update("lead", { trustLevel: 2 }).catch((e: unknown) => e))).toMatchObject({ status: 403, message: expect.stringMatching(/one step at a time/) });
  });

  it("restores a demoted bot and clears the demotion", async () => {
    const data = createFixtureBotsData();
    const cv = await data.update("cv", { trustLevel: 2 });
    expect(cv).toMatchObject({ trustLevel: 2, demotion: null });
  });

  it("deletes a memory note and dismisses a suggestion", async () => {
    const data = createFixtureBotsData();
    expect((await data.deleteMemoryNote("lead", "Ask one question max before starting a scan.")).memory).toEqual(["Ba prefers product companies over outsourcing."]);
    expect((await data.dismissPromotion("apply")).promotionSuggested).toBe(false);
  });
});
