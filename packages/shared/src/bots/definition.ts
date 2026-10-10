// bot.json (§5.1): a bot is data, not code.
import { z } from "zod";
import {
  BotNameSchema,
  DomainSchema,
  EngineSchema,
  LIMITS,
  TrustLevelSchema,
  type Phase1Bot,
} from "../common/primitives.js";
import { BOT_OUTPUT_SCHEMA_NAMES, type BotOutputSchemaName } from "./registry.js";

export const BotOutputSchemaNameSchema = z.enum(
  BOT_OUTPUT_SCHEMA_NAMES as [BotOutputSchemaName, ...BotOutputSchemaName[]],
);

/** Task kinds per Phase 1 bot (§5.2, §7.2–7.3b). */
export const BOT_TASK_KINDS = {
  lead: ["chat"],
  research: ["scan", "single", "file", "fit", "company"],
  cv: ["tailor"],
  qa: ["review"],
  apply: ["submit"],
} as const satisfies Record<Phase1Bot, readonly string[]>;

/** Kinds any bot can run: 1:1 consult (UC-25) and room discussion (UC-15). Output = ConsultOutput. */
export const CONVERSATION_TASK_KINDS = ["consult", "discussion"] as const;

export const BrowserModeSchema = z.enum(["read", "write"]);

export const BrowserConfigSchema = z
  .object({
    /** read = navigate/read/screenshot only; write = full interaction (forms, upload, submit). */
    mode: BrowserModeSchema,
    allowedSites: z.array(DomainSchema),
    /** Apply: sites come from the approval token's allowed domains (§10.2 rule 7). */
    sitesFromApproval: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.allowedSites.length === 0 && !v.sitesFromApproval) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowedSites"],
        message: "a browser bot needs allowedSites (or sitesFromApproval)",
      });
    }
  });
export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;

export const BotDefinitionSchema = z
  .object({
    name: BotNameSchema,
    displayName: z.string().min(1),
    role: z.string().min(1),
    engine: EngineSchema.describe("switchable in the UI"),
    model: z.string().min(1).nullable().describe("null = CLI default for the subscription"),
    trustLevel: TrustLevelSchema,
    /** Abstract tool patterns (e.g. web_search, chrome:read, skill:source-*); the runner maps them per engine. */
    allowedTools: z.array(z.string().min(1)).default([]),
    browser: BrowserConfigSchema.nullable().default(null),
    mcpServers: z.array(z.string().min(1)).default([]),
    timeoutSec: z.number().int().positive().default(LIMITS.timeoutSecDefault),
    /**
     * Name of the output schema in packages/shared, or a map task kind → name for bots
     * with several task kinds (Research). consult/discussion kinds always use ConsultOutput.
     */
    outputSchema: z.union([BotOutputSchemaNameSchema, z.record(z.string().min(1), BotOutputSchemaNameSchema)]),
    selfCheck: z.array(z.string().min(1)).min(1),
    /** Bumped on every ROLE.md change. */
    promptVersion: z.number().int().positive(),
    enabled: z.boolean().default(true),
  })
  .strict();
export type BotDefinition = z.infer<typeof BotDefinitionSchema>;
export type BotDefinitionInput = z.input<typeof BotDefinitionSchema>;

/** Which output schema the runner validates a task of `kind` against. */
export function resolveOutputSchemaName(def: Pick<BotDefinition, "name" | "outputSchema">, kind: string): BotOutputSchemaName {
  const map = typeof def.outputSchema === "string" ? null : def.outputSchema;
  const fromMap = map?.[kind];
  if (fromMap) return fromMap;
  if ((CONVERSATION_TASK_KINDS as readonly string[]).includes(kind)) return "ConsultOutput";
  if (typeof def.outputSchema === "string") return def.outputSchema;
  throw new Error(`bot ${def.name} has no output schema for task kind "${kind}"`);
}

/** Browser bots that write must run on Claude, where the site guard is a hook (§4.4). */
export function isOutwardFacingBrowser(def: Pick<BotDefinition, "browser">): boolean {
  return def.browser?.mode === "write";
}
