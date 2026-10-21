// CV guidance copy and small rules for the screens (design screens/guidance.md, review.md,
// activity.md). Text from the rule set is plain text everywhere (SEC-26): only https links.
import type { GuidanceReviewEntry, GuidanceSourceRef, GuidanceView, ReviewGuidance } from "@bs-job-agents/shared";

/** SEC-26: a source URL is a link only when it is https; anything else is shown as text. */
export function safeHref(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** A source's name: its title, else its publisher. */
export const sourceName = (s: Pick<GuidanceSourceRef, "title" | "publisher">): string => s.title ?? s.publisher ?? "Untitled source";

/** Where a source lives: its URL, or the repo file (the VNPT post). */
export const sourceAddress = (s: Pick<GuidanceSourceRef, "url" | "repoPath">): string => s.url ?? s.repoPath ?? "";

export function dateLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function timeLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "12 rules from 4 sources. Last checked 18 Oct 2026, 15:00; changed 1 rule." */
export function summaryLine(view: GuidanceView): string {
  const head = `${plural(view.rules.length, "rule")} from ${plural(view.sourceCount, "source")}.`;
  const last = view.lastRefresh;
  if (!last) return `${head} Not checked by a scan yet.`;
  if (last.outcome === "failed") return `${head} Last successful check ${view.lastSuccessAt ? timeLabel(view.lastSuccessAt) : "never"}.`;
  return `${head} Last checked ${timeLabel(last.at)}; changed ${plural(last.rulesChanged, "rule")}.`;
}

/** "3 of 5 sources could not be read this run; their rules stay as they were." */
export function partialLine(view: GuidanceView): string | null {
  const last = view.lastRefresh;
  if (!last || last.outcome === "failed" || last.failed === 0) return null;
  return `${last.failed} of ${last.pagesChecked} sources could not be read this run; their rules stay as they were.`;
}

export const STATUS_TEXT: Record<GuidanceReviewEntry["status"], string> = {
  met: "Met",
  not_met: "Not met",
  needs_fact: "Needs fact",
  not_applicable: "Not applicable",
  overridden: "Overridden",
  disputed_not_applied: "Disputed, not applied",
  turned_off: "Turned off",
  not_reviewed: "Not reviewed",
};

/** The panel's sentence: "2 rules need your attention. Checked in 2 rounds; the CV was revised once." */
export function reviewSummary(g: Pick<ReviewGuidance, "rounds" | "revisions">, attention: number): string {
  const need = attention === 1 ? "1 rule needs your attention." : `${attention} rules need your attention.`;
  const revised = g.revisions === 0 ? "the CV was not revised" : g.revisions === 1 ? "the CV was revised once" : g.revisions === 2 ? "the CV was revised twice" : `the CV was revised ${g.revisions} times`;
  return `${need} Checked in ${plural(g.rounds, "round")}; ${revised}.`;
}
