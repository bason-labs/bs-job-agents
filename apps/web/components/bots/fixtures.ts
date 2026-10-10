// The five Phase 1 bots as the Bots screen sees them (BotView), from the shared bot.json
// fixtures plus the prototype's track records, prompt versions and memory notes. CV starts
// demoted (§5.3) so the restore path is visible until the API reports real demotions.
import { canPromote } from "@bs-job-agents/shared";
import { botDefinitionFixtures } from "@bs-job-agents/shared/fixtures";
import type { BotScreenView } from "./logic";

type Extra = Pick<BotScreenView, "role" | "trackRecord" | "promotionSuggested" | "memory" | "residualRisk" | "demotion" | "promptVersion"> &
  Partial<Pick<BotScreenView, "trustLevel" | "activity">>;

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
    residualRisk:
      "On Codex, Research's site allowlist is only in its prompt: its sandbox can read any file on this Mac and it can run shell commands. A job page that injects instructions could make it leak local files. Running it on Claude limits it to its task folder (owner decision E1, pending).",
    demotion: null,
    activity: "working",
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

export const BOT_VIEWS: BotScreenView[] = botDefinitionFixtures.map((def) => {
  const extra = EXTRA[def.name]!;
  const trustLevel = extra.trustLevel ?? def.trustLevel;
  return {
    name: def.name,
    displayName: def.displayName,
    engine: def.engine,
    model: def.model,
    enabled: def.enabled ?? true,
    activity: extra.activity ?? "idle",
    ...extra,
    trustLevel,
    promoteAllowed: canPromote(def.name, trustLevel).allowed,
  };
});
