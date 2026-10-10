import { SEARCH_PROFILE_DEFAULTS, type SearchProfileFieldsBase } from "@bs-job-agents/shared";
import { desc, eq, max } from "drizzle-orm";
import type { Conn } from "../client.js";
import { NotFoundError } from "../errors.js";
import { searchProfiles } from "../schema.js";
import { nowIso, type ClockOpts } from "../time.js";
import type { SearchProfile } from "../types.js";

export const DEFAULT_PROFILE_NAME = "Default";

/**
 * Editable fields of a Search Profile (shared `SearchProfileFieldsBase`, §7.5). Omitted
 * fields take the shared §7.5 defaults. Validation (UC-21b b) is the API's job, with
 * the shared `SearchProfileFieldsSchema`.
 */
export type SearchProfileInput = Pick<SearchProfileFieldsBase, "roles" | "locations"> &
  Partial<Omit<SearchProfileFieldsBase, "roles" | "locations">>;

/** The shared §7.5 defaults (lowercase source keys, CV languages ["en"]). */
export { SEARCH_PROFILE_DEFAULTS };

type ProfileFields = SearchProfileFieldsBase;

function fieldsOf(p: SearchProfile): ProfileFields {
  const {
    roles, locations, workModes, minSalary, currency, seniority, sources, includeKeywords, excludeKeywords,
    excludeCompanies, companyTypes, languages, maxJobs, fitThreshold, salaryPolicy, salaryAmount,
  } = p;
  return {
    roles, locations, workModes, minSalary, currency, seniority, sources, includeKeywords, excludeKeywords,
    excludeCompanies, companyTypes, languages, maxJobs, fitThreshold, salaryPolicy, salaryAmount,
  };
}

function deactivateAll(db: Conn): void {
  db.update(searchProfiles).set({ active: false }).where(eq(searchProfiles.active, true)).run();
}

function insertVersion(db: Conn, name: string, fields: ProfileFields, active: boolean, now: string): SearchProfile {
  const version =
    (db
      .select({ v: max(searchProfiles.version) })
      .from(searchProfiles)
      .where(eq(searchProfiles.name, name))
      .get()?.v ?? 0) + 1;
  if (active) deactivateAll(db);
  return db
    .insert(searchProfiles)
    .values({
      ...fields,
      workModes: [...fields.workModes],
      seniority: [...fields.seniority],
      sources: [...fields.sources],
      includeKeywords: [...fields.includeKeywords],
      excludeKeywords: [...fields.excludeKeywords],
      excludeCompanies: [...fields.excludeCompanies],
      companyTypes: [...fields.companyTypes],
      languages: [...fields.languages],
      name,
      version,
      active,
      updatedAt: now,
    })
    .returning()
    .get();
}

/** Seed a profile (e.g. from Ba's first chat request, §15.3). Becomes active by default. */
export function createSearchProfile(
  db: Conn,
  input: SearchProfileInput,
  opts: ClockOpts & { name?: string; activate?: boolean } = {},
): SearchProfile {
  return db.transaction((tx) =>
    insertVersion(
      tx,
      opts.name ?? DEFAULT_PROFILE_NAME,
      { ...SEARCH_PROFILE_DEFAULTS, ...input } as ProfileFields,
      opts.activate ?? true,
      nowIso(opts),
    ),
  );
}

export function getSearchProfile(db: Conn, id: number): SearchProfile | undefined {
  return db.select().from(searchProfiles).where(eq(searchProfiles.id, id)).get();
}

export function getActiveSearchProfile(db: Conn): SearchProfile | undefined {
  return db.select().from(searchProfiles).where(eq(searchProfiles.active, true)).get();
}

/** Newest version first (the Search criteria screen's version history). */
export function listSearchProfileVersions(db: Conn, name: string): SearchProfile[] {
  return db
    .select()
    .from(searchProfiles)
    .where(eq(searchProfiles.name, name))
    .orderBy(desc(searchProfiles.version))
    .all();
}

export function latestSearchProfileVersion(db: Conn, name: string): SearchProfile | undefined {
  return listSearchProfileVersions(db, name)[0];
}

/**
 * UC-21b: saving creates a new version (copy of the latest + patch). It becomes
 * active when the profile was active. Runs keep the version id they started with.
 * Field validation (≥ 1 role/location/source, salary + currency) is the API's
 * job, via the shared Zod schema.
 */
export function updateSearchProfile(
  db: Conn,
  patch: Partial<SearchProfileInput>,
  opts: ClockOpts & { name?: string } = {},
): SearchProfile {
  return db.transaction((tx) => {
    const active = getActiveSearchProfile(tx);
    const name = opts.name ?? active?.name;
    const base = name ? latestSearchProfileVersion(tx, name) : undefined;
    if (!name || !base) throw new NotFoundError("search profile", name ?? "(active)");
    const wasActive = active?.name === name;
    return insertVersion(tx, name, { ...fieldsOf(base), ...patch } as ProfileFields, wasActive, nowIso(opts));
  });
}

export function setActiveSearchProfile(db: Conn, id: number): SearchProfile {
  return db.transaction((tx) => {
    if (!getSearchProfile(tx, id)) throw new NotFoundError("search profile", id);
    deactivateAll(tx);
    return tx.update(searchProfiles).set({ active: true }).where(eq(searchProfiles.id, id)).returning().get()!;
  });
}

/**
 * The profile a schedule or run should use: NULL → the active profile; an id →
 * the latest version of that profile (schedules follow edits, UC-21b).
 */
export function resolveSearchProfile(db: Conn, id: number | null | undefined): SearchProfile | undefined {
  if (id === null || id === undefined) return getActiveSearchProfile(db);
  const row = getSearchProfile(db, id);
  return row ? latestSearchProfileVersion(db, row.name) : undefined;
}
