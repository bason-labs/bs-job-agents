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
    /**
     * Optional self-check list per task kind (Research checks a scan, a fit and a company profile
     * differently). Kinds without an entry use `selfCheck`; consult/discussion use CONSULT_SELF_CHECK.
     */
    selfCheckByKind: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)).default({}),
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

/** The self-check item for consult (UC-25) and discussion (UC-15) answers. */
export const CONSULT_SELF_CHECK = ["Answered within my role; no work was done"] as const;

/** Self-check items for a task of `kind` (rule 4): consult item, per-kind list, or the bot's list. */
export function resolveSelfCheckItems(
  def: Pick<BotDefinition, "selfCheck"> & { selfCheckByKind?: Record<string, string[]> },
  kind: string,
): string[] {
  if ((CONVERSATION_TASK_KINDS as readonly string[]).includes(kind)) return [...CONSULT_SELF_CHECK];
  return [...(def.selfCheckByKind?.[kind] ?? def.selfCheck)];
}

/** The only tools Lead may have (§3 rule 5): orchestrator MCP tools. */
export const LEAD_TOOL_PREFIX = "mcp:orchestrator:";

/** The MCP server name of the local Figma bridge (figma-console-mcp) in bot.json `mcpServers`. */
export const FIGMA_MCP_SERVER_NAME = "figma";

/**
 * Phase 1 safety rules for a bot definition (PM S6). Empty = safe.
 * - §4.4: a browser bot that writes runs on Claude, where the site allowlist is a hook.
 * - §6.2 (QA Phase 2): a bot with the Figma bridge runs on Claude, where a PreToolUse hook rejects
 *   figma_execute code that reaches outside the Drafts page (Codex has no hooks).
 * - UC-19: Apply stays at L1 (every submit needs Ba's approval token).
 * - §3 rule 5: Lead has only orchestrator MCP tools: no browser, Figma, shell or file tools.
 */
export function checkBotSafety(
  def: Pick<BotDefinition, "name" | "engine" | "trustLevel" | "browser" | "allowedTools" | "mcpServers">,
): string[] {
  const issues: string[] = [];
  if (def.browser?.mode === "write" && def.engine !== "claude") {
    issues.push(`${def.name}: a browser bot that writes must run on Claude, where the site allowlist is enforced by a hook (§4.4)`);
  }
  if (def.mcpServers.includes(FIGMA_MCP_SERVER_NAME) && def.engine !== "claude") {
    issues.push(`${def.name}: a bot with the Figma bridge must run on Claude, where the Drafts-only guard is a hook (§6.2)`);
  }
  if (def.name === "apply" && def.trustLevel !== 1) {
    issues.push("apply: Apply stays at trust level L1 in Phase 1, so every submit needs Ba's approval (UC-19)");
  }
  if (def.name === "lead") {
    const extra = def.allowedTools.filter((t) => !t.startsWith(LEAD_TOOL_PREFIX));
    if (extra.length > 0) issues.push(`lead: only orchestrator MCP tools are allowed (rule 5), not ${extra.join(", ")}`);
    if (def.browser) issues.push("lead: no browser (rule 5)");
    const servers = def.mcpServers.filter((s) => s !== "orchestrator");
    if (servers.length > 0) issues.push(`lead: only the orchestrator MCP server is allowed (rule 5), not ${servers.join(", ")}`);
  }
  return issues;
}

/** BotDefinitionSchema plus the Phase 1 safety rules; use it wherever a bot.json is loaded or changed. */
export const SafeBotDefinitionSchema = BotDefinitionSchema.superRefine((def, ctx) => {
  for (const message of checkBotSafety(def)) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
});
