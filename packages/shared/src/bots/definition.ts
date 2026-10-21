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
  // guidance_extract / guidance_discover (CV guidance §5.4): rules from pages the orchestrator fetched (no
  // tools) and candidate source URLs (web search only), never a page read through Chrome.
  // repair (skill self-repair §5.2): a new source skill drafted from the board's pages, read-only.
  research: ["scan", "single", "file", "fit", "company", "guidance_extract", "guidance_discover", "repair"],
  // fact_draft (owner request 2026-10-11): Ba's own words → master facts on the Master CV screen; no tools.
  // derive (CV auto-extend): facts Ba's own facts support or imply for a job's gaps; no tools.
  // review (CV guidance §5.7): a tailored CV against the applied judgement rules; no tools.
  cv: ["tailor", "fact_draft", "derive", "review"],
  qa: ["review"],
  apply: ["submit"],
} as const satisfies Record<Phase1Bot, readonly string[]>;

/**
 * Task keys that run with no tools at all (no files, MCP, browser or web search): everything they
 * need is in the task input. cv.fact_draft drafts master facts from Ba's own words; cv.derive drafts
 * facts his facts support or imply for a job's gaps.
 */
export const TOOLLESS_TASK_KEYS = ["cv.fact_draft", "cv.derive", "cv.review", "research.guidance_extract"] as const;

export function isToollessTask(botName: string, kind: string): boolean {
  return (TOOLLESS_TASK_KEYS as readonly string[]).includes(`${botName}.${kind}`);
}

/**
 * Task keys that may only search the web (SEC-20): no Read, skills, Chrome or MCP. research.guidance_discover
 * returns candidate URLs, which the orchestrator fetches itself under SEC-21.
 */
export const WEB_SEARCH_ONLY_TASK_KEYS = ["research.guidance_discover"] as const;

export function isWebSearchOnlyTask(botName: string, kind: string): boolean {
  return (WEB_SEARCH_ONLY_TASK_KEYS as readonly string[]).includes(`${botName}.${kind}`);
}

/**
 * Task keys that read Ba's Chrome but nothing else (skill self-repair §5.2): the scan's Chrome read
 * tools and site guard, and Read for the bot's skill files; no web search, MCP, write or shell.
 */
export const BROWSER_READ_ONLY_TASK_KEYS = ["research.repair"] as const;

export function isBrowserReadOnlyTask(botName: string, kind: string): boolean {
  return (BROWSER_READ_ONLY_TASK_KEYS as readonly string[]).includes(`${botName}.${kind}`);
}

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

/** The orchestrator's own MCP server (Lead's six tools) in bot.json `mcpServers`. */
export const ORCHESTRATOR_MCP_SERVER_NAME = "orchestrator";

/** PM3 M1: why Lead never runs on another engine. */
export const LEAD_ENGINE_RULE = "lead: Lead must run on Claude, where its only tools are the orchestrator's (rule 5)";

/** The MCP server name of the local Figma bridge (figma-console-mcp) in bot.json `mcpServers`. */
export const FIGMA_MCP_SERVER_NAME = "figma";

/**
 * Owner decision 2026-10-11: Ba may run a Figma bot (CV) on Codex, as an explicit opt-in recorded
 * per bot (bots.engine_risk_ack_at), to save Claude quota. The Drafts-only hook cannot run there;
 * the protected-page fingerprint before and after every CV task is the only backstop. bot.json
 * never carries the opt-in: only Ba's acknowledgement on the Bots screen does.
 */
export interface BotSafetyOptions {
  /** Ba acknowledged running this bot's Figma bridge without the Drafts-only guard hook. */
  unguardedFigmaAcknowledged?: boolean;
}

/** What Ba confirms before CV runs on Codex (Bots screen dialog; the API's 409 repeats it). */
export const FIGMA_UNGUARDED_RISK =
  "On Codex the Figma guard can't block edits as they happen. The app still checks your protected pages before and after every CV task and alerts you (and stops CV) if anything changed; Figma's version history can restore it. Codex can also read files on your Mac.";

type SafetyFields = Pick<BotDefinition, "name" | "engine" | "trustLevel" | "browser" | "allowedTools" | "mcpServers">;

/**
 * Phase 1 safety rules for a bot definition (PM S6). Empty = safe.
 * - §4.4: a browser bot that writes runs on Claude, where the site allowlist is a hook.
 * - §6.2 (QA Phase 2): a bot with the Figma bridge runs on Claude, where a PreToolUse hook rejects
 *   figma_execute code that reaches outside the Drafts page (Codex has no hooks), unless Ba opted in
 *   to Codex for it (owner decision 2026-10-11, `opts.unguardedFigmaAcknowledged`).
 * - UC-19: Apply stays at L1 (every submit needs Ba's approval token).
 * - §3 rule 5: Lead has only orchestrator MCP tools: no browser, Figma, shell or file tools.
 */
export function checkBotSafety(def: SafetyFields, opts: BotSafetyOptions = {}): string[] {
  const issues: string[] = [];
  if (def.browser?.mode === "write" && def.engine !== "claude") {
    issues.push(`${def.name}: a browser bot that writes must run on Claude, where the site allowlist is enforced by a hook (§4.4)`);
  }
  if (def.mcpServers.includes(FIGMA_MCP_SERVER_NAME) && def.engine !== "claude" && opts.unguardedFigmaAcknowledged !== true) {
    issues.push(
      `${def.name}: a bot with the Figma bridge must run on Claude, where the Drafts-only guard is a hook (§6.2), unless Ba opts in to Codex on the Bots screen`,
    );
  }
  if (def.name === "apply" && def.trustLevel !== 1) {
    issues.push("apply: Apply stays at trust level L1 in Phase 1, so every submit needs Ba's approval (UC-19)");
  }
  if (def.mcpServers.includes(ORCHESTRATOR_MCP_SERVER_NAME) && def.name !== "lead") {
    issues.push(`${def.name}: only Lead may use the orchestrator MCP server (rule 5)`);
  }
  if (def.name === "lead") {
    // PM3 M1: the six-tool limit (--tools / --strict-mcp-config) exists only on Claude; on Codex every
    // session also has a shell, apply_patch and sub-agents, and its MCP URL would sit in argv.
    if (def.engine !== "claude") issues.push(LEAD_ENGINE_RULE);
    const extra = def.allowedTools.filter((t) => !t.startsWith(LEAD_TOOL_PREFIX));
    if (extra.length > 0) issues.push(`lead: only orchestrator MCP tools are allowed (rule 5), not ${extra.join(", ")}`);
    if (def.browser) issues.push("lead: no browser (rule 5)");
    const servers = def.mcpServers.filter((s) => s !== ORCHESTRATOR_MCP_SERVER_NAME);
    if (servers.length > 0) issues.push(`lead: only the orchestrator MCP server is allowed (rule 5), not ${servers.join(", ")}`);
  }
  return issues;
}

/**
 * Whether moving `def` to `engine` is refused without Ba's opt-in and allowed with it (CV to
 * Codex): the Bots screen asks him to confirm the risk, and PATCH /bots/:name needs acknowledgeRisk.
 */
export function engineSwitchNeedsAcknowledgement(def: SafetyFields, engine: BotDefinition["engine"]): boolean {
  const moved = { ...def, engine };
  return checkBotSafety(moved).length > 0 && checkBotSafety(moved, { unguardedFigmaAcknowledged: true }).length === 0;
}

/** BotDefinitionSchema plus the Phase 1 safety rules; use it wherever a bot.json is loaded or changed. */
export const SafeBotDefinitionSchema = BotDefinitionSchema.superRefine((def, ctx) => {
  for (const message of checkBotSafety(def)) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
});
