import { eq } from "drizzle-orm";
import type { Conn } from "../client.js";
import { companyKey } from "../dedupe.js";
import type { CompanyConfidence } from "../enums.js";
import { NotFoundError } from "../errors.js";
import { companies, type JsonObject } from "../schema.js";
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

/** Store a `CompanyProfile` from `research.company` (UC-05). */
export function saveCompanyProfile(
  db: Conn,
  id: number,
  input: { profile: JsonObject; confidence: CompanyConfidence; website?: string | null; researchedAt?: Date | string },
  opts?: ClockOpts,
): Company {
  const row = db
    .update(companies)
    .set({
      profile: input.profile,
      confidence: input.confidence,
      researchedAt: input.researchedAt ? toIso(input.researchedAt) : nowIso(opts),
      ...(input.website !== undefined ? { website: input.website } : {}),
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
  return ageMs < (opts.maxAgeDays ?? 30) * 86_400_000 ? company : undefined;
}
