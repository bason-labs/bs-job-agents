// API research (design 2026-10-19 §5.1): Ba's approval to read a high-risk board through its account
// API. It holds for the access record Ba read: once the record's researchedAt changes it lapses.
import { eq } from "drizzle-orm";
import type { Conn } from "../client.js";
import { sourceApprovals } from "../schema.js";
import { nowIso, type ClockOpts } from "../time.js";

export interface SourceApproval {
  source: string;
  approvedAt: string;
  researchedAt: string;
}

export function getSourceApproval(db: Conn, source: string): SourceApproval | undefined {
  return db.select().from(sourceApprovals).where(eq(sourceApprovals.source, source)).get();
}

/** Approved for this research (a lapsed approval counts as none). */
export function isSourceApproved(db: Conn, source: string, researchedAt: string): boolean {
  return getSourceApproval(db, source)?.researchedAt === researchedAt;
}

export function approveSource(db: Conn, input: { source: string; researchedAt: string }, opts?: ClockOpts): SourceApproval {
  const approvedAt = nowIso(opts);
  return db
    .insert(sourceApprovals)
    .values({ source: input.source, approvedAt, researchedAt: input.researchedAt })
    .onConflictDoUpdate({ target: sourceApprovals.source, set: { approvedAt, researchedAt: input.researchedAt } })
    .returning()
    .get();
}

/** True when an approval was removed. */
export function revokeSource(db: Conn, source: string): boolean {
  return db.delete(sourceApprovals).where(eq(sourceApprovals.source, source)).run().changes > 0;
}
