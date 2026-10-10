// The Bots screen (§11 Bots, UC-19): each bot's row (the Bots-screen engine, trust level and enabled
// flag) with its role from bot.json, live activity, track record and promotion suggestion (§5.3),
// its memory (bots/<name>/memory.md) and, for a Codex bot that reads the browser, the residual risk
// (§4.4: its site allowlist is only its prompt).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { maxTrustLevel, type BotActivity, type BotDefinition, type BotView, type TrustLevel } from "@bs-job-agents/shared";
import { listRuns, listSteps, listTasks, mappers, type Bot, type Db } from "../../db/index.js";
import type { ActionStepOutput, GateStepOutput, HumanStepOutput, WorkflowSource } from "../../engine/index.js";

/** §5.3: 10 consecutive tasks accepted without changes. */
export const PROMOTION_STREAK = 10;

export function botActivity(db: Db, name: string): BotActivity {
  const statuses = new Set(listTasks(db, { status: ["running", "paused", "waiting_limit"] }).filter((t) => t.botName === name).map((t) => t.status));
  if (statuses.has("running")) return "working";
  if (statuses.has("paused")) return "paused";
  if (statuses.has("waiting_limit")) return "waiting_limit";
  return "idle";
}

/** Memory notes, oldest first, without the list marker. */
export function botMemory(botsDir: string, name: string): string[] {
  const path = join(botsDir, name, "memory.md");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.replace(/^[-*]\s+/, ""));
}

interface Streak {
  count: number;
  label: (n: number) => string;
}

/**
 * The §5.3 promotion rule, newest first: CV counts QA-gate passes on the first round; Apply counts
 * approvals without intro edits whose Apply submitted. Other bots have no rule in Phase 1.
 */
function streakOf(db: Db, workflows: WorkflowSource | null, name: string): Streak | null {
  if (name !== "cv" && name !== "apply") return null;
  const events: { at: string; ok: boolean }[] = [];
  for (const run of listRuns(db)) {
    const def = workflows?.get(run.workflowName, run.workflowVersion);
    if (!def) continue;
    const steps = listSteps(db, run.id);
    if (name === "cv") {
      const gates = new Set(def.steps.filter((s) => s.type === "gate").map((s) => s.key));
      for (const row of steps.filter((s) => gates.has(s.stepKey) && s.status === "done")) {
        const out = row.output as GateStepOutput | null;
        if (!out || !Array.isArray(out.rounds)) continue;
        const rounds = out.rounds.filter((r) => r.pass === out.pass);
        events.push({ at: row.finishedAt ?? "", ok: out.outcome === "passed" && rounds.length === 1 });
      }
    } else {
      const humans = def.steps.filter((s) => s.type === "human");
      for (const human of humans) {
        const action = def.steps.find((s) => s.type === "action" && s.approvalFrom === human.key);
        for (const row of steps.filter((s) => s.stepKey === human.key)) {
          const approvals = ((row.output as HumanStepOutput | null)?.decisions ?? []).filter((d) => d.decision === "approve");
          const last = approvals.at(-1);
          if (!last || !action) continue;
          const outcome = (steps.find((s) => s.stepKey === action.key && s.branchKey === row.branchKey)?.output as ActionStepOutput | null)?.outcome;
          if (!outcome) continue;
          events.push({ at: last.at, ok: outcome === "submitted" && !approvals.some((d) => d.introEdited) });
        }
      }
    }
  }
  if (events.length === 0) return null;
  events.sort((a, b) => b.at.localeCompare(a.at));
  let count = 0;
  for (const e of events) {
    if (!e.ok) break;
    count++;
  }
  return {
    count,
    label: name === "cv" ? (n) => `${n} passed QA on the first round in a row` : (n) => `${n} approved in a row without edits`,
  };
}

const RESIDUAL_RISK =
  "On Codex this bot's site allowlist is enforced only by its prompt, and its read-only sandbox can read files on this Mac (§4.4). Switch it to Claude for a site guard in code.";

export function botView(db: Db, opts: { botsDir: string; workflows: WorkflowSource | null }, def: BotDefinition | undefined, row: Bot | undefined): BotView | null {
  if (!def && !row) return null;
  const name = (row?.name ?? def?.name)!;
  const record = row
    ? mappers.toBotRecord(row)
    : {
        name,
        displayName: def!.displayName,
        engine: def!.engine,
        model: def!.model,
        trustLevel: def!.trustLevel,
        promptVersion: def!.promptVersion,
        enabled: def!.enabled,
      };
  const streak = streakOf(db, opts.workflows, name);
  const level = record.trustLevel as TrustLevel;
  return {
    ...record,
    role: def?.role ?? "",
    activity: botActivity(db, name),
    trackRecord: streak && streak.count > 0 ? streak.label(streak.count) : null,
    // UC-19: the suggestion shows even for Apply, whose promote button stays disabled.
    promotionSuggested: streak !== null && streak.count >= PROMOTION_STREAK && level < 2,
    // Promote or restore one level, up to the Phase 1 cap (Apply: L1).
    promoteAllowed: level < maxTrustLevel(name),
    memory: botMemory(opts.botsDir, name),
    residualRisk: record.engine === "codex" && def?.browser ? RESIDUAL_RISK : null,
  };
}
