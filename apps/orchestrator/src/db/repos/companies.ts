import { LIMITS, type CompanyProfile } from "@bs-job-agents/shared";
import { eq } from "drizzle-orm";
import type { Conn } from "../client.js";
import { companyKey } from "../dedupe.js";
import { NotFoundError } from "../errors.js";
import { companies } from "../schema.js";
import { nowIso, toIso, type ClockOpts } from "../time.js";
import type { Company } from "../types.js";

/** Find by normalised name, or create a stub without a profile (jobs reference it). */
export function ensureCompany(db: Conn, input: { name: string; website?: string | null }): Company {
  const nameKey = companyKey(input.name) || input.name.trim().toLowerCase();
  const existing = db.select().from(companies).where(eq(companies.nameKey, nameKey)).get();
  if (existing) {
    if (!existing.website && input.website) {
      return db.update(companies).set({ website: input.website }).where(eq(companies.id, existing.id)).returning().get()!;
    }
    return existing;
  }
  return db
    .insert(companies)
    .values({ name: input.name.trim(), nameKey, website: input.website ?? null })
    .returning()
    .get();
}

export function getCompany(db: Conn, id: number): Company | undefined {
  return db.select().from(companies).where(eq(companies.id, id)).get();
}

export function findCompanyByName(db: Conn, name: string): Company | undefined {
  return db.select().from(companies).where(eq(companies.nameKey, companyKey(name))).get();
}

/**
 * Store a shared `CompanyProfile` from `research.company` (UC-05). Confidence and
 * website come from the profile; `researched_at` is the orchestrator's clock (the cache
 * rule must not trust a model-written timestamp) unless given.
 */
export function saveCompanyProfile(
  db: Conn,
  id: number,
  input: { profile: CompanyProfile; researchedAt?: Date | string },
  opts?: ClockOpts,
): Company {
  const row = db
    .update(companies)
    .set({
      profile: input.profile,
      confidence: input.profile.confidence,
      researchedAt: input.researchedAt ? toIso(input.researchedAt) : nowIso(opts),
      ...(input.profile.website ? { website: input.profile.website } : {}),
    })
    .where(eq(companies.id, id))
    .returning()
    .get();
  if (!row) throw new NotFoundError("company", id);
  return row;
}

/** Cached profile younger than `maxAgeDays` (default 30, UC-05a), else undefined. */
export function getFreshCompanyProfile(
  db: Conn,
  companyId: number,
  opts: ClockOpts & { maxAgeDays?: number } = {},
): Company | undefined {
  const company = getCompany(db, companyId);
  if (!company?.profile || !company.researchedAt) return undefined;
  const now = (opts.now ?? new Date()).getTime();
  const ageMs = now - new Date(company.researchedAt).getTime();
  return ageMs < (opts.maxAgeDays ?? LIMITS.companyProfileCacheDays) * 86_400_000 ? company : undefined;
}
