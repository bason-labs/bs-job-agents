import type { SubmissionRefusalReason } from "@bs-job-agents/shared";

export class NotFoundError extends Error {
  constructor(
    readonly entity: string,
    readonly id: string | number,
  ) {
    super(`${entity} ${id} not found`);
    this.name = "NotFoundError";
  }
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly entity: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`${entity}: cannot go from ${from} to ${to}`);
    this.name = "InvalidTransitionError";
  }
}

/** Raised for any attempt to change the frozen submission record (spec §9.1). */
export class ImmutableRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImmutableRecordError";
  }
}

/**
 * recordSubmission refused to write the §9.1 record, and wrote nothing: the record would
 * contradict the application or its approval. The caller (engine) keeps the raw Apply result
 * on the task, marks the application `needs_check` and appends `safety.denied`.
 */
export class SubmissionRefusedError extends Error {
  constructor(
    readonly reason: SubmissionRefusalReason,
    readonly applicationId: number,
    detail: string,
  ) {
    super(`submission record for application ${applicationId} refused (${reason}): ${detail}`);
    this.name = "SubmissionRefusedError";
  }
}

/** A trigger or index openDb() requires after migrating (schema-guard.ts). */
export interface GuardedSchemaObject {
  type: "trigger" | "index";
  name: string;
  /** The table it belongs to. */
  table: string;
}

/**
 * openDb() found a guarded trigger or index missing after migrating (PM M4): most likely a
 * migration rebuilt a table, which drops its triggers. The orchestrator must not start,
 * because the §9.1 record and the approval rules would no longer be enforced.
 */
export class SchemaGuardError extends Error {
  constructor(readonly missing: readonly GuardedSchemaObject[]) {
    super(
      `database schema is missing ${missing.length} guarded object(s): ${missing
        .map((o) => `${o.type} ${o.name} on ${o.table}`)
        .join(", ")}. A migration probably rebuilt a table and dropped them; refusing to start (spec §9.1).`,
    );
    this.name = "SchemaGuardError";
  }
}
