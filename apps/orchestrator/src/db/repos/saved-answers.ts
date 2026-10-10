import { normalizeAnswerKey } from "@bs-job-agents/shared";
import { asc, eq } from "drizzle-orm";
import type { Conn } from "../client.js";
import { savedAnswers } from "../schema.js";
import { nowIso, type ClockOpts } from "../time.js";
import type { SavedAnswer } from "../types.js";

/** UC-12: key = normalised label (the shared implementation, so the API and the DB agree). */
export { normalizeAnswerKey };

/** "Remember this answer". */
export function saveAnswer(db: Conn, input: { label: string; answer: string }, opts?: ClockOpts): SavedAnswer {
  const key = normalizeAnswerKey(input.label);
  const updatedAt = nowIso(opts);
  return db
    .insert(savedAnswers)
    .values({ key, label: input.label.trim(), answer: input.answer, updatedAt })
    .onConflictDoUpdate({ target: savedAnswers.key, set: { label: input.label.trim(), answer: input.answer, updatedAt } })
    .returning()
    .get();
}

export function getSavedAnswer(db: Conn, label: string): SavedAnswer | undefined {
  return db.select().from(savedAnswers).where(eq(savedAnswers.key, normalizeAnswerKey(label))).get();
}

export function listSavedAnswers(db: Conn): SavedAnswer[] {
  return db.select().from(savedAnswers).orderBy(asc(savedAnswers.key)).all();
}

export function deleteSavedAnswer(db: Conn, label: string): boolean {
  return db.delete(savedAnswers).where(eq(savedAnswers.key, normalizeAnswerKey(label))).run().changes > 0;
}
