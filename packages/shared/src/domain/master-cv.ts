// Master CV data (§6.1, `data/master-cv.yaml`, UC-20). Owned by Ba; bots only read it.
// CV auto-extend (§5.1): a fact the orchestrator derived from Ba's own facts carries a `derived`
// block (the facts it rests on, with a hash of each at derivation time). Ba's own facts have none,
// so files written before it parse, and print, unchanged. Whether a derived fact is still backed is
// computed, never stored (derivedStatus), so a hand edit of the YAML is caught too.
import { z } from "zod";
import { claimsIn } from "../truth/claims.js";

export const FactTypeSchema = z.enum(["experience", "project", "skill", "education", "metric"]);
export type FactType = z.infer<typeof FactTypeSchema>;

/** Fact ids are lowercase slugs such as grad-1. */
export const FACT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** How a derived fact rests on a cited fact: the fact says it (supports) or implies it in a well-known way. */
export const DerivedRelationSchema = z.enum(["supports", "implied_from"]);
export type DerivedRelation = z.infer<typeof DerivedRelationSchema>;

/** An id written in the YAML (a job or task id); a bare number reads as its digits. */
const IdTextSchema = z.preprocess((v) => (typeof v === "number" ? String(v) : v), z.string().min(1).nullable().default(null));

export const DerivedSourceSchema = z.object({
  factId: z.string().regex(FACT_ID_PATTERN),
  relation: DerivedRelationSchema,
  /** factSourceHash of the cited fact when this fact was derived. */
  sourceHash: z.string().min(1),
});
export type DerivedSource = z.infer<typeof DerivedSourceSchema>;

export const DerivedBlockSchema = z.object({
  restsOn: z.array(DerivedSourceSchema).min(1),
  /** table: the implication table, by code; model: CV's cv.derive task, screened by code. */
  via: z.enum(["table", "model"]),
  rationale: z.string().min(1).nullable().default(null),
  /** The JD gap it answers. */
  requirement: z.string().min(1),
  jobId: IdTextSchema,
  /** The cv.derive task; null for a table derivation. */
  taskId: IdTextSchema,
  derivedAt: z.string().min(1),
});
export type DerivedBlock = z.infer<typeof DerivedBlockSchema>;

export const FactSchema = z.object({
  id: z.string().regex(FACT_ID_PATTERN, "fact ids are lowercase slugs such as grad-1"),
  type: FactTypeSchema,
  text: z.string().min(1),
  /** Vietnamese wording when it exists. */
  textVi: z.string().min(1).nullable().default(null),
  tags: z.array(z.string()).default([]),
  org: z.string().nullable().default(null),
  dates: z.string().nullable().default(null),
  /** Set only on a fact the orchestrator derived (CV auto-extend); absent on Ba's own facts. */
  derived: DerivedBlockSchema.optional(),
});
export type Fact = z.infer<typeof FactSchema>;

export const MasterCvSchema = z
  .object({
    /** Bumped on every save (UC-20). */
    version: z.number().int().positive(),
    contact: z.object({
      name: z.string().min(1),
      email: z.string().email(),
      phone: z.string().nullable().default(null),
      location: z.string().nullable().default(null),
      links: z.array(z.string().url()).default([]),
    }),
    headlineOptions: z.array(z.object({ en: z.string().min(1), vi: z.string().nullable().default(null) })).default([]),
    facts: z.array(FactSchema),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.facts.forEach((f, i) => {
      if (seen.has(f.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["facts", i, "id"], message: `duplicate fact id ${f.id}` });
      }
      seen.add(f.id);
    });
    // SEC-16: no chains. A derived fact rests on Ba's own facts only (a missing one is "source changed").
    const byId = new Map(v.facts.map((f) => [f.id, f]));
    v.facts.forEach((f, i) => {
      f.derived?.restsOn.forEach((r, j) => {
        if (byId.get(r.factId)?.derived) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["facts", i, "derived", "restsOn", j, "factId"], message: `${f.id} rests on ${r.factId}, which is itself derived` });
        }
      });
    });
  });
export type MasterCv = z.infer<typeof MasterCvSchema>;
export type MasterCvInput = z.input<typeof MasterCvSchema>;

// ---------------------------------------------------------------- derived facts (CV auto-extend §5.1)

export const isDerivedFact = (f: Pick<Fact, "derived">): boolean => f.derived !== undefined;

/** FNV-1a, 64 bits, as 16 hex characters: small, pure and the same in Node and the browser. */
function fnv1a64(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    h ^= BigInt(byte);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

/**
 * The hash a derived fact keeps of each fact it rests on: its text, org and the years of its dates
 * (and whether they run to the present). textVi and months are left out on purpose: fixing a
 * translation, or adding months to "2023 – 2025", does not flag the facts that rest on it.
 */
export function factSourceHash(f: Pick<Fact, "text" | "org" | "dates">): string {
  const dates = claimsIn(f.dates ?? "");
  const years = dates.numbers.filter((n) => /^\d{4}$/.test(n));
  const squash = (s: string | null) => (s ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
  return fnv1a64(JSON.stringify([squash(f.text), squash(f.org), years, dates.present]));
}

export type DerivedStatus = "active" | "source_changed";

/**
 * Computed on every read: a derived fact is `source_changed` when a fact it rests on is gone, is
 * itself derived, or changed (text, org, or the years of its dates) since it was derived. Ba's own
 * facts are always active.
 */
export function derivedStatus(cv: Pick<MasterCv, "facts">, fact: Fact): DerivedStatus {
  if (!fact.derived) return "active";
  for (const r of fact.derived.restsOn) {
    const cited = cv.facts.find((f) => f.id === r.factId);
    if (!cited || cited.derived || factSourceHash(cited) !== r.sourceHash) return "source_changed";
  }
  return "active";
}

/** Ba's own facts (no derived block). */
export function ownFacts(cv: Pick<MasterCv, "facts">): Fact[] {
  return cv.facts.filter((f) => !f.derived);
}

/** Facts a task may use: Ba's own and every derived fact whose sources still hold. */
export function activeFacts(cv: Pick<MasterCv, "facts">): Fact[] {
  return cv.facts.filter((f) => derivedStatus(cv, f) === "active");
}

/** A fact as tasks see it: a derived fact says so and names its sources, nothing more. */
export type TaskFact = Omit<Fact, "derived"> & { derived?: true; restsOn?: string[] };
export type TaskMasterCv = Omit<MasterCv, "facts"> & { facts: TaskFact[] };

/**
 * The per-task copy of the master CV (SEC-18): flagged derived facts are left out, and a derived
 * fact keeps only `derived: true` and its source ids. research.fit, cv.tailor and qa.review read the
 * same projection, so QA judges a CV against exactly what tailor could cite.
 */
export function masterCvForTasks(cv: MasterCv): TaskMasterCv {
  return {
    ...cv,
    facts: activeFacts(cv).map(({ derived, ...f }) => (derived ? { ...f, derived: true as const, restsOn: derived.restsOn.map((r) => r.factId) } : f)),
  };
}
