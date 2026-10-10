import { describe, expect, it } from "vitest";
import { BOT_VIEWS } from "./fixtures";
import { engineLockReason, promoteAction, promotionText, qaEngineWarning, restoreTarget, type BotScreenView } from "./logic";

const bot = (name: string, over: Partial<BotScreenView> = {}): BotScreenView => ({ ...BOT_VIEWS.find((b) => b.name === name)!, ...over });

describe("engineLockReason (§4.4, §6.2, PM S10/S25)", () => {
  it("locks Apply and CV to Claude, with the reason shown", () => {
    expect(engineLockReason("apply")).toBe("Locked to Claude: Apply fills forms in your Chrome, and its site allowlist runs only on Claude.");
    expect(engineLockReason("cv")).toBe("Locked to Claude: CV edits Figma; its Drafts-only guard runs only on Claude.");
  });

  it("leaves the other bots switchable", () => {
    for (const name of ["lead", "research", "qa"]) expect(engineLockReason(name)).toBeNull();
  });
});

describe("promotion (§5.3, UC-19)", () => {
  it("words the suggestion like the prototype", () => {
    expect(promotionText(bot("apply"))).toBe("System suggests promoting Apply to L2 (10 approved in a row without edits).");
  });

  it("keeps Apply's promote button disabled in Phase 1", () => {
    expect(promoteAction(bot("apply"))).toEqual({
      allowed: false,
      label: "Promote (disabled in Phase 1 for Apply)",
      reason: "Promoting Apply to L2 is disabled in Phase 1",
      to: 2,
    });
  });

  it("lets Ba accept a suggestion for another bot", () => {
    expect(promoteAction(bot("lead", { promotionSuggested: true, promoteAllowed: true }))).toEqual({ allowed: true, label: "Promote to L2", reason: null, to: 2 });
  });
});

describe("restoreTarget (PM S21: one level back, Apply up to L1 only)", () => {
  it("restores a demoted bot one level at a time, up to where it was", () => {
    expect(restoreTarget(bot("cv", { trustLevel: 1, demotion: { fromLevel: 2, at: "2026-10-10T18:20:00+07:00", reason: "x" } }))).toBe(2);
    expect(restoreTarget(bot("research", { trustLevel: 0, demotion: { fromLevel: 2, at: "2026-10-10T18:20:00+07:00", reason: "x" } }))).toBe(1);
  });

  it("never restores Apply above L1", () => {
    expect(restoreTarget(bot("apply", { trustLevel: 0, demotion: { fromLevel: 1, at: "2026-10-10T18:20:00+07:00", reason: "x" } }))).toBe(1);
    expect(restoreTarget(bot("apply", { trustLevel: 1, demotion: { fromLevel: 2, at: "2026-10-10T18:20:00+07:00", reason: "x" } }))).toBeNull();
  });

  it("has nothing to restore without a demotion", () => {
    expect(restoreTarget(bot("qa", { demotion: null }))).toBeNull();
  });
});

describe("qaEngineWarning (§5.2: QA deliberately on a different engine from CV)", () => {
  it("warns only when QA and CV share an engine", () => {
    expect(qaEngineWarning(BOT_VIEWS)).toBeNull();
    const same = BOT_VIEWS.map((b) => (b.name === "qa" ? { ...b, engine: "claude" as const } : b));
    expect(qaEngineWarning(same)).toBe("QA checks CV's work, so it should run on a different engine from CV (both are on Claude now).");
  });
});
