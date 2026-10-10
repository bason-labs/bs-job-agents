// PM phase 1, M4: the §9.1 immutability triggers and the one-application-per-job index
// must survive every migration. SQLite drops a table's triggers and indexes along with
// the table, and drizzle-kit rebuilds a table (create new, copy, drop old, rename)
// whenever a CHECK, a NOT NULL or the column order changes. Nothing would notice, so
// openDb() checks this list after migrating and refuses to start if anything is missing.
//
// Migration rules (phases.md rule 4): never rebuild `applications`, `submissions`,
// `job_snapshots` or `approvals`; use ADD COLUMN. A migration that adds a trigger adds
// it here too (schema-guard.test.ts fails on an unguarded trigger).
import type Database from "better-sqlite3";
import { SchemaGuardError, type GuardedSchemaObject } from "./errors.js";

export type { GuardedSchemaObject };

export const GUARDED_SCHEMA_OBJECTS = [
  // §9.1: the submission record is frozen once written (0001).
  { type: "trigger", name: "submissions_no_update", table: "submissions" },
  { type: "trigger", name: "submissions_no_delete", table: "submissions" },
  // PM M1: a record cites the consumed token of its own application and the approved PDF; an
  // approved CV version keeps its PDF (0005).
  { type: "trigger", name: "submissions_match_approval", table: "submissions" },
  { type: "trigger", name: "cv_versions_pdf_frozen_once_approved", table: "cv_versions" },
  { type: "trigger", name: "job_snapshots_no_update", table: "job_snapshots" },
  { type: "trigger", name: "job_snapshots_no_delete", table: "job_snapshots" },
  // §9.1, UC-13: a recorded application is never deleted; only its status changes,
  // appended to its history (0001; the last two re-created stricter in 0003).
  { type: "trigger", name: "applications_no_delete_recorded", table: "applications" },
  { type: "trigger", name: "applications_frozen_after_record", table: "applications" },
  { type: "trigger", name: "applications_history_append_only", table: "applications" },
  // PM M3: a dry run never reaches a post-submit status, and its flag never changes (0003).
  { type: "trigger", name: "applications_dry_run_update_guard", table: "applications" },
  { type: "trigger", name: "applications_dry_run_insert_guard", table: "applications" },
  // UC-08, §10.2 rule 1: approval tokens are single-use (0001).
  { type: "trigger", name: "approvals_single_use", table: "approvals" },
  // PM M2: an approval is immutable except used_at and allowed domains, which only grow until
  // a submission cites the token; it is never deleted (0004).
  { type: "trigger", name: "approvals_immutable", table: "approvals" },
  { type: "trigger", name: "approvals_no_delete", table: "approvals" },
  { type: "trigger", name: "approvals_domains_grow_only", table: "approvals" },
  // §10.2 rule 5: one application per job unless "apply again" (0000).
  { type: "index", name: "applications_job_uq", table: "applications" },
] as const satisfies readonly GuardedSchemaObject[];

/** The guarded objects `sqlite_master` does not have (by type, name and table). */
export function missingGuardedObjects(client: Database.Database): GuardedSchemaObject[] {
  const rows = client
    .prepare("SELECT type, name, tbl_name AS tbl FROM sqlite_master WHERE type IN ('trigger', 'index')")
    .all() as { type: string; name: string; tbl: string }[];
  const present = new Set(rows.map((r) => `${r.type}\u0000${r.name}\u0000${r.tbl}`));
  return GUARDED_SCHEMA_OBJECTS.filter((o) => !present.has(`${o.type}\u0000${o.name}\u0000${o.table}`)).map((o) => ({ ...o }));
}

/** Throws SchemaGuardError if any guarded trigger or index is missing. */
export function assertGuardedSchema(client: Database.Database): void {
  const missing = missingGuardedObjects(client);
  if (missing.length > 0) throw new SchemaGuardError(missing);
}
