// Output checks (spec §5.5 steps 4–5): Zod validation, self-check coverage, failed items,
// and the one repair prompt sent in the same session.
import { parseBotOutput, type BotOutputSchemaName, type Engine, type SelfCheckItem } from "@bs-job-agents/shared";

export type OutputCheck = { ok: true; output: unknown } | { ok: false; missing: boolean; errors: string[] };

const MAX_ERRORS = 20;

const normalizeItem = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[‘’“”"'`]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[\s.;:!]+$/g, "")
    .trim();

/** Validate with the bot's Zod schema, then check every expected self-check item was reported. */
export function checkOutput(schemaName: BotOutputSchemaName, value: unknown, selfCheckItems: readonly string[]): OutputCheck {
  if (value === undefined) return { ok: false, missing: true, errors: ["no structured output"] };
  const parsed = parseBotOutput(schemaName, value);
  if (!parsed.success) {
    const errors = parsed.error.issues.slice(0, MAX_ERRORS).map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`);
    return { ok: false, missing: false, errors };
  }
  const reported = (parsed.data as { selfCheck: SelfCheckItem[] }).selfCheck.map((s) => normalizeItem(s.item));
  const missingItems = selfCheckItems.filter((item) => {
    const want = normalizeItem(item);
    return !reported.some((got) => got === want || got.includes(want) || (got.length > 20 && want.includes(got)));
  });
  if (missingItems.length > 0) {
    return { ok: false, missing: false, errors: missingItems.map((item) => `selfCheck: missing item "${item}"`) };
  }
  return { ok: true, output: parsed.data };
}

/** Failed self-check items as "item — note" (rule 4: any failed item fails the attempt). */
export function failedSelfCheckItems(output: unknown): string[] {
  const items = (output as { selfCheck?: SelfCheckItem[] } | null)?.selfCheck ?? [];
  return items.filter((i) => !i.passed).map((i) => (i.note ? `${i.item} — ${i.note}` : i.item));
}

export interface RepairPromptInput {
  schemaName: BotOutputSchemaName;
  errors: readonly string[];
  /** The previous turn ended without any structured output. */
  missing: boolean;
  engine: Engine;
}

/**
 * The one repair prompt (§5.5 step 4), sent in the same session with every tool switched off.
 * Live runs showed a model re-judging its self-check as failed when it noticed its tools were
 * gone, so the prompt says tools are off on purpose and the earlier results stand.
 */
export function repairPrompt(r: RepairPromptInput): string {
  const head = r.missing
    ? `Your previous turn ended without the structured output for schema ${r.schemaName}.`
    : `Your previous structured output failed validation against schema ${r.schemaName}:\n${r.errors.map((e) => `- ${e}`).join("\n")}`;
  const ask = r.missing
    ? `Emit the complete output now as valid JSON for schema ${r.schemaName}, based on the work you already did.`
    : `Re-emit the complete output as valid JSON for schema ${r.schemaName}, fixing every point above.`;
  const handIn = r.engine === "claude" ? "Hand it in with the StructuredOutput tool." : "Your final message must be only the JSON object.";
  return [
    head,
    ask,
    "Tools are switched off for this turn on purpose: do not use any tool and do not redo the work. Keep the self-check results of the work you already did.",
    handIn,
  ].join("\n\n");
}
