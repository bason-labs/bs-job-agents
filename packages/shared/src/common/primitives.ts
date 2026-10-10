// Primitive schemas and constants reused across modules.
import { z } from "zod";

/** Opaque string id (ULID/UUID/slug; the DB decides). */
export const IdSchema = z.string().min(1);
export type Id = z.infer<typeof IdSchema>;

/** ISO-8601 timestamp with offset, e.g. `2026-10-10T15:40:00+07:00` or `...Z`. */
export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

/** Absolute http(s) URL. */
export const UrlSchema = z.string().url().regex(/^https?:\/\//i, "expected an http(s) URL");

/** Lowercase hex SHA-256 digest (§9.1). */
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, "expected a lowercase hex SHA-256");
export type Sha256 = z.infer<typeof Sha256Schema>;

/** Host name without scheme or path, e.g. `topcv.vn`. */
export const DomainSchema = z
  .string()
  .regex(/^(?=.{1,253}$)([a-z0-9-]+\.)*[a-z0-9-]+$/i, "expected a host name such as topcv.vn");

/** Bot name: unique, lowercase (§5.1). */
export const BotNameSchema = z.string().regex(/^[a-z][a-z0-9-]*$/, "bot names are lowercase slugs");
export type BotName = z.infer<typeof BotNameSchema>;

/** The five Phase 1 bots (§5.2). New bots may be added later, so BotNameSchema stays open. */
export const PHASE1_BOTS = ["lead", "research", "cv", "qa", "apply"] as const;
export type Phase1Bot = (typeof PHASE1_BOTS)[number];

/** Engine = which subscription CLI runs the bot (§1.4). */
export const EngineSchema = z.enum(["claude", "codex"]);
export type Engine = z.infer<typeof EngineSchema>;

/** Trust levels L0/L1/L2 (§5.3), stored as numbers in bot.json. */
export const TrustLevelSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);
export type TrustLevel = z.infer<typeof TrustLevelSchema>;
export const TRUST_LEVEL_LABELS = { 0: "L0", 1: "L1", 2: "L2" } as const satisfies Record<TrustLevel, string>;
export type TrustLevelLabel = (typeof TRUST_LEVEL_LABELS)[TrustLevel];
export const TRUST_LEVEL_MEANINGS = {
  0: "Draft only; every output needs Ba's acceptance",
  1: "Acts, but every outward-facing action needs an approval token",
  2: "Acts on its own within its allowed tools",
} as const satisfies Record<TrustLevel, string>;
export const trustLevelLabel = (level: TrustLevel): TrustLevelLabel => TRUST_LEVEL_LABELS[level];

/** CV languages (§6.3). */
export const CvLanguageSchema = z.enum(["en", "vi"]);
export type CvLanguage = z.infer<typeof CvLanguageSchema>;

/** Detected JD language: ISO 639-1 code (`vi`, `en`, `ja`, …). */
export const LanguageCodeSchema = z.string().regex(/^[a-z]{2}$/, "expected an ISO 639-1 code such as en or vi");

/** §6.3: VI JD → VI + EN CVs (VI default); anything else → EN only. */
export function cvLanguagesForJd(jdLanguage: string): CvLanguage[] {
  return jdLanguage === "vi" ? ["vi", "en"] : ["en"];
}

export const CurrencySchema = z.enum(["VND", "USD"]);
export type Currency = z.infer<typeof CurrencySchema>;

export const WorkModeSchema = z.enum(["onsite", "hybrid", "remote"]);
export type WorkMode = z.infer<typeof WorkModeSchema>;

export const SenioritySchema = z.enum(["intern", "junior", "mid", "senior", "lead"]);
export type Seniority = z.infer<typeof SenioritySchema>;

/** Toggleable scan sources (§7.5, §15.1). Career sites come only via links or on request. */
export const SearchSourceSchema = z.enum(["topcv", "itviec", "linkedin"]);
export type SearchSource = z.infer<typeof SearchSourceSchema>;

/**
 * Where a job came from. Open string so new adapters need no schema change;
 * known values: topcv, itviec, linkedin, career_site, link, file.
 */
export const JobSourceSchema = z.string().regex(/^[a-z][a-z0-9_]*$/, "job source is a lowercase key");
export const KNOWN_JOB_SOURCES = ["topcv", "itviec", "linkedin", "career_site", "link", "file"] as const;

/** Thresholds and limits from the spec. */
export const LIMITS = {
  /** §5.2 QA pass rule */
  qaPassScore: 80,
  /** §7.2 step 7 */
  qaMaxRounds: 3,
  /** §7.5 defaults */
  fitThresholdDefault: 60,
  maxJobsDefault: 5,
  /** §5.5 attempt policy: initial + 1 retry */
  maxAttempts: 2,
  /** §5.1 / §10.1 */
  timeoutSecDefault: 600,
  /** §5.4 */
  memoryNotesMax: 3,
  memoryLinesMax: 200,
  /** UC-08: approval token lifetime */
  approvalTokenTtlMs: 24 * 60 * 60 * 1000,
  /** UC-05 a: company profile cache */
  companyProfileCacheDays: 30,
  /** UC-21: undo window for schedule delete */
  scheduleUndoMs: 6000,
  /** §7.4 catch-up window */
  catchUpWindowMs: 12 * 60 * 60 * 1000,
  /** §10.3 default per-engine session caps */
  engineSessionsDefault: { claude: 2, codex: 2 },
  /** UC-16: pause before the wall */
  usagePauseUtilization: 0.95,
  /** UC-16: retry interval when the reset time is not parseable */
  usageRetryMs: 30 * 60 * 1000,
  /** UC-24 */
  uploadMaxBytes: 10 * 1024 * 1024,
  /** UC-03 c */
  linkedinMaxPageViews: 40,
} as const;
