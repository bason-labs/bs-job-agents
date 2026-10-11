import { describe, expect, it } from "vitest";
import { seedBotViews } from "@/lib/api/mock/seed-bots";
import { engineLockReason, engineSwitchDisabled, engineSwitchRisk, figmaGuardNote, lowerTarget, memoryNotesOf, promoteAction, promotionText, qaEngineWarning, raiseTarget, restoreTarget, type BotScreenView } from "./logic";

const BOT_VIEWS = seedBotViews();

describe("memoryNotesOf (PM S14)", () => {
  it("lists the notes with ids when the API sends them, else the plain lines without ids", () => {
    const lead = BOT_VIEWS.find((b) => b.name === "lead")!;
    expect(memoryNotesOf(lead).map((n) => n.text)).toEqual(lead.memory);
    expect(memoryNotesOf(lead).every((n) => /^[0-9a-f]{16}$/.test(n.id ?? ""))).toBe(true);
    expect(memoryNotesOf({ memory: ["a"], memoryNotes: undefined })).toEqual([{ id: null, text: "a" }]);
  });
});

const bot = (name: string, over: Partial<BotScreenView> = {}): BotScreenView => ({ ...BOT_VIEWS.find((b) => b.name === name)!, ...over });

describe("engineLockReason (§4.4, §6.2, PM S10/S25)", () => {
  it("locks Apply and Lead to Claude, with the reason shown (PM3 M1 for Lead)", () => {
    expect(engineLockReason("apply")).toBe("Locked to Claude: Apply fills forms in your Chrome, and its site allowlist runs only on Claude.");
    expect(engineLockReason("lead")).toBe("Locked to Claude: Lead only divides work, and its tool limit holds only on Claude.");
  });

  it("leaves the other bots switchable; CV too, as an opt-in (owner decision 2026-10-11)", () => {
    for (const name of ["research", "qa", "cv"]) expect(engineLockReason(name)).toBeNull();
    expect(engineSwitchDisabled({ name: "cv", engine: "claude" })).toBe(false);
  });

  it("CV to Codex asks Ba to confirm the risk in plain words; other switches don't", () => {
    expect(engineSwitchRisk("cv", "codex")).toBe(
      "On Codex the Figma guard can't block edits as they happen. The app still checks your protected pages before and after every CV task and alerts you (and stops CV) if anything changed; Figma's version history can restore it. Codex can also read files on your Mac.",
    );
    expect(engineSwitchRisk("cv", "claude")).toBeNull();
    for (const name of ["research", "qa", "apply", "lead"]) expect(engineSwitchRisk(name, "codex")).toBeNull();
  });

  it("notes CV's Figma guard is off while it runs on Codex", () => {
    expect(figmaGuardNote({ figmaGuardOff: true })).toBe("Figma guard off (Codex)");
    expect(figmaGuardNote({ figmaGuardOff: false })).toBeNull();
    expect(figmaGuardNote({})).toBeNull();
  });

  it("a locked bot stored on Codex (before the rule) can still be switched back to Claude", () => {
    expect(engineSwitchDisabled({ name: "lead", engine: "claude" })).toBe(true);
    expect(engineSwitchDisabled({ name: "lead", engine: "codex" })).toBe(false);
    expect(engineSwitchDisabled({ name: "research", engine: "codex" })).toBe(false);
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

describe("raiseTarget / lowerTarget (W3a PATCH /bots/:name rules)", () => {
  it("raises one level while the API allows it (below the Phase 1 cap)", () => {
    expect(raiseTarget(bot("lead"))).toBe(2);
    expect(raiseTarget(bot("cv", { trustLevel: 1, promoteAllowed: true }))).toBe(2);
    expect(raiseTarget(bot("research"))).toBeNull(); // already L2
    expect(raiseTarget(bot("apply"))).toBeNull(); // Apply stays L1
    expect(raiseTarget(bot("apply", { trustLevel: 0, promoteAllowed: true }))).toBe(1);
  });

  it("lowers one level down to L0", () => {
    expect(lowerTarget(bot("apply"))).toBe(0);
    expect(lowerTarget(bot("research"))).toBe(1);
    expect(lowerTarget(bot("lead", { trustLevel: 0 }))).toBeNull();
  });
});

describe("qaEngineWarning (§5.2: QA deliberately on a different engine from CV)", () => {
  it("warns only when QA and CV share an engine", () => {
    expect(qaEngineWarning(BOT_VIEWS)).toBeNull();
    const same = BOT_VIEWS.map((b) => (b.name === "qa" ? { ...b, engine: "claude" as const } : b));
    expect(qaEngineWarning(same)).toBe("QA checks CV's work, so it should run on a different engine from CV (both are on Claude now).");
  });
});
