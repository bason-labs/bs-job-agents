// The five Phase 1 bots as GET /bots answers them (BotView), from the shared bot.json fixtures
// plus the prototype's track records, prompt versions and memory notes. CV starts demoted (§5.3)
// so the restore path shows; memory notes carry ids like W3a's (16 hex digits, PM S14).
import { maxTrustLevel, type BotView } from "@bs-job-agents/shared";
import { botDefinitionFixtures } from "@bs-job-agents/shared/fixtures";

type Extra = Pick<BotView, "role" | "trackRecord" | "promotionSuggested" | "memory" | "residualRisk" | "demotion" | "promptVersion"> &
  Partial<Pick<BotView, "trustLevel">>;

const EXTRA: Record<string, Extra> = {
  lead: {
    role: "Receives every request; only divides work.",
    trackRecord: null,
    promotionSuggested: false,
    promptVersion: 3,
    memory: ["Ba prefers product companies over outsourcing.", "Ask one question max before starting a scan."],
    residualRisk: null,
    demotion: null,
  },
  research: {
    role: "Finds jobs, scores fit, profiles companies (read-only browser).",
    trackRecord: "41 tasks · 95% self-check pass",
    promotionSuggested: false,
    promptVersion: 2,
    memory: ['TopCV salary often hidden: read "Mức lương" field.', "LinkedIn: stop at 40 page views."],
    // E1 option A (W4c): Research runs on Claude, so there is no residual-risk note until Ba switches it.
    residualRisk: null,
    demotion: null,
  },
  cv: {
    role: "Tailors CV in Figma from master facts; never invents.",
    trackRecord: "18 CVs · 61% pass QA first round",
    promotionSuggested: false,
    promptVersion: 4,
    memory: ['Template "Refreshed" fits 1 page with max 3 projects.', "Always check hidden frames before export."],
    residualRisk: null,
    trustLevel: 1,
    demotion: {
      fromLevel: 2,
      at: "2026-10-10T18:20:00+07:00",
      reason: "the Kite Labs CV left the QA gate with a hard fail (a Python claim with no supporting fact)",
    },
  },
  qa: {
    role: "Scores CV vs JD + company; hard-fails invented facts.",
    trackRecord: "29 reviews",
    promotionSuggested: false,
    promptVersion: 2,
    memory: ["Vietnamese JDs: check diacritics in PDF text."],
    residualRisk: null,
    demotion: null,
  },
  apply: {
    role: "Fills & submits forms in your Chrome after your approval.",
    trackRecord: "10 approved in a row without edits",
    promotionSuggested: true,
    promptVersion: 1,
    memory: ["TopCV: upload limit 5MB."],
    residualRisk: null,
    demotion: null,
  },
};

/** A stable 16-hex-digit id for a note (the orchestrator hashes the memory.md line). */
export function noteId(bot: string, text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const ch of `${bot}\u0000${text}`) {
    const c = ch.codePointAt(0)!;
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ c, 2246822519) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

export const withMemoryNotes = (bot: string, memory: readonly string[]) => memory.map((text) => ({ id: noteId(bot, text), text }));

/** The orchestrator's note for a browser bot on Codex (views/bots.ts), recomputed on an engine switch. */
export const CODEX_BROWSER_RISK =
  "On Codex, Research's site allowlist is only in its prompt: its sandbox can read any file on this Mac and it can run shell commands. A job page that injects instructions could make it leak local files. Running it on Claude limits it to its task folder (owner decision E1).";

/** Engines as Ba last set them (bot.json after W4c: Research on Claude, E1 option A). */
const ENGINE_OVERRIDE: Partial<Record<string, BotView["engine"]>> = { research: "claude" };

export function residualRiskFor(name: string, engine: BotView["engine"]): string | null {
  const def = botDefinitionFixtures.find((d) => d.name === name);
  return engine === "codex" && def?.browser ? CODEX_BROWSER_RISK : null;
}

export function seedBotViews(): BotView[] {
  return botDefinitionFixtures.map((def) => {
    const extra = EXTRA[def.name]!;
    const trustLevel = extra.trustLevel ?? def.trustLevel;
    return {
      name: def.name,
      displayName: def.displayName,
      engine: ENGINE_OVERRIDE[def.name] ?? def.engine,
      model: def.model,
      defaultModel: def.model,
      enabled: def.enabled ?? true,
      activity: "idle",
      ...extra,
      trustLevel,
      // The API: below the Phase 1 cap (W3a views/bots.ts).
      promoteAllowed: trustLevel < maxTrustLevel(def.name),
      memoryNotes: withMemoryNotes(def.name, extra.memory),
    };
  });
}
