// Registry of bot output schemas by name. bot.json `outputSchema` refers to these names (§5.1).
import type { z } from "zod";
import { toStrictJsonSchema, type JsonSchema } from "../json-schema/strict.js";
import { ApplyOutputSchema } from "./apply.js";
import { ConsultOutputSchema } from "./consult.js";
import { CvOutputSchema } from "./cv.js";
import { LeadOutputSchema } from "./lead.js";
import { QaOutputSchema } from "./qa.js";
import {
  ResearchCompanyOutputSchema,
  ResearchFitOutputSchema,
  ResearchScanOutputSchema,
} from "./research.js";

export const BOT_OUTPUT_SCHEMAS = {
  LeadOutput: LeadOutputSchema,
  ResearchScanOutput: ResearchScanOutputSchema,
  ResearchFitOutput: ResearchFitOutputSchema,
  ResearchCompanyOutput: ResearchCompanyOutputSchema,
  CvOutput: CvOutputSchema,
  QaOutput: QaOutputSchema,
  ApplyOutput: ApplyOutputSchema,
  ConsultOutput: ConsultOutputSchema,
} as const;

export type BotOutputSchemaName = keyof typeof BOT_OUTPUT_SCHEMAS;
export type BotOutputOf<N extends BotOutputSchemaName> = z.infer<(typeof BOT_OUTPUT_SCHEMAS)[N]>;

export const BOT_OUTPUT_SCHEMA_NAMES = Object.keys(BOT_OUTPUT_SCHEMAS) as BotOutputSchemaName[];

export function isBotOutputSchemaName(name: string): name is BotOutputSchemaName {
  return Object.prototype.hasOwnProperty.call(BOT_OUTPUT_SCHEMAS, name);
}

export function getBotOutputSchema<N extends BotOutputSchemaName>(name: N): (typeof BOT_OUTPUT_SCHEMAS)[N] {
  return BOT_OUTPUT_SCHEMAS[name];
}

const jsonCache = new Map<BotOutputSchemaName, JsonSchema>();

/** Strict JSON Schema for a bot output: Codex `--output-schema` file and Claude `--json-schema`. */
export function getBotOutputJsonSchema(name: BotOutputSchemaName): JsonSchema {
  let js = jsonCache.get(name);
  if (!js) {
    js = toStrictJsonSchema(BOT_OUTPUT_SCHEMAS[name], { name });
    jsonCache.set(name, js);
  }
  return js;
}

/** Validate structured output from an engine (§5.5 step 4). */
export function parseBotOutput<N extends BotOutputSchemaName>(name: N, value: unknown) {
  return (BOT_OUTPUT_SCHEMAS[name] as z.ZodType<BotOutputOf<N>>).safeParse(value);
}
