// CV guidance (AD-13): one stored guidance review per CV round (per language: the gate is per
// language, REQ-37.AC-5), and the guidance fact requests appended to that CV version, deduplicated
// by rule, fact and field.
import { GuidanceReviewResultSchema, type CvFactRequest, type GuidanceFactRequest, type GuidanceReviewResult } from "@bs-job-agents/shared";
import { eq } from "drizzle-orm";
import type { Conn } from "../client.js";
import { cvVersions, guidanceReviews } from "../schema.js";
import { nowIso, type ClockOpts } from "../time.js";

export interface GuidanceReviewRow {
  id: number;
  cvVersionId: number;
  snapshot: number | null;
  result: GuidanceReviewResult;
  createdAt: string;
}

/** Store (or replace, when cv.review completes a round checked by code first) a CV round's review. */
export function saveGuidanceReview(db: Conn, input: { cvVersionId: number; result: GuidanceReviewResult }, opts?: ClockOpts): GuidanceReviewRow {
  const result = GuidanceReviewResultSchema.parse(input.result);
  const values = { cvVersionId: input.cvVersionId, snapshot: result.snapshot, result, createdAt: nowIso(opts) };
  return db
    .insert(guidanceReviews)
    .values(values)
    .onConflictDoUpdate({ target: guidanceReviews.cvVersionId, set: { snapshot: values.snapshot, result: values.result, createdAt: values.createdAt } })
    .returning()
    .get();
}

export function getGuidanceReview(db: Conn, cvVersionId: number): GuidanceReviewRow | undefined {
  const row = db.select().from(guidanceReviews).where(eq(guidanceReviews.cvVersionId, cvVersionId)).get();
  if (!row) return undefined;
  const parsed = GuidanceReviewResultSchema.safeParse(row.result);
  return parsed.success ? { ...row, result: parsed.data } : undefined;
}

const key = (r: { ruleId?: string; factId?: string; field?: string }) => `${r.ruleId}\u0000${r.factId}\u0000${r.field}`;

/** Append guidance fact requests to a CV version (§5.8), once each by (rule, fact, field). */
export function appendGuidanceFactRequests(db: Conn, cvVersionId: number, requests: readonly (GuidanceFactRequest & { ruleLabel: string })[]): void {
  const row = db.select({ factRequests: cvVersions.factRequests }).from(cvVersions).where(eq(cvVersions.id, cvVersionId)).get();
  if (!row || requests.length === 0) return;
  const existing = row.factRequests ?? [];
  const seen = new Set(existing.filter((r) => r.origin === "guidance").map(key));
  const added: CvFactRequest[] = [];
  for (const r of requests) {
    if (seen.has(key(r))) continue;
    seen.add(key(r));
    added.push({ topic: r.ruleLabel, question: r.question, reason: `CV guidance: ${r.ruleLabel}`, origin: "guidance", ruleId: r.ruleId, factId: r.factId, field: r.field });
  }
  if (added.length > 0) db.update(cvVersions).set({ factRequests: [...existing, ...added] }).where(eq(cvVersions.id, cvVersionId)).run();
}
