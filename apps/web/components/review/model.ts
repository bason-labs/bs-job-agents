// Pure logic behind a review card (§11 Review queue; UC-07..10; PM S24): copy for the job line,
// QA rounds, flags and the approve button.
import { FIND_ONLY_NOTE, QA_MAX_ROUNDS, sourceLabel as searchSourceLabel, type CvVersion, type Job, type QaReviewRecord, type ReviewCard } from "@bs-job-agents/shared";
import { errorMessage, isApiError } from "@/lib/api/errors";
import { statusMeta } from "@/lib/status";
import { formatDateTime } from "@/components/schedules/datetime";

export type CvOption = ReviewCard["cvOptions"][number];

const SOURCE_LABELS: Record<string, string> = {
  topcv: "TopCV",
  itviec: "ITviec",
  linkedin: "LinkedIn",
  career_site: "Career site",
  link: "Pasted link",
  file: "Uploaded file",
};

/** W5: the new boards (VietnamWorks, Remote OK, …) take their labels from shared SEARCH_SOURCES. */
export const sourceLabel = (source: string) => SOURCE_LABELS[source] ?? searchSourceLabel(source);

/** "ITviec · Ho Chi Minh City · hybrid · 2,000–2,800 USD · JD language: EN". */
export function jobMeta(job: Job): string {
  return [sourceLabel(job.source), job.location, job.workMode, job.salaryText ?? "salary not listed", `JD language: ${job.language.toUpperCase()}`]
    .filter(Boolean)
    .join(" · ");
}

/** The site Apply works on (the approval token's domain). */
export function applyDomain(job: Pick<Job, "url">): string | null {
  if (!job.url) return null;
  try {
    return new URL(job.url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function roundLabel(cv: Pick<CvVersion, "round">): string {
  return cv.round <= QA_MAX_ROUNDS ? `round ${cv.round} of ${QA_MAX_ROUNDS}` : `round ${cv.round}`;
}

export function hardFailText(qa: QaReviewRecord): string {
  if (!qa.hardFails.length) return "Hard fails: none · Truth check: every claim traced to master facts ✓";
  return `Hard fails: ${qa.hardFails.map((f) => `${f.code.replace(/_/g, " ")} — ${f.detail}${f.section ? ` (${f.section})` : ""}`).join("; ")}`;
}

/** UC-07 a: why QA did not pass, from the weakest score of the last round. */
export function escalationNote(option: CvOption): string {
  const last = option.qaRounds.at(-1);
  const rounds = option.qaRounds.length;
  const why = last?.hardFails[0]?.detail ?? last?.scores.jdMatch.justification ?? "the score stayed under 80";
  const sentence = /[.!?]$/.test(why) ? why : `${why}.`;
  return `QA did not pass after ${rounds} ${rounds === 1 ? "round" : "rounds"}: ${sentence} Decide: approve anyway, request changes, or skip.`;
}

export type NoticeTone = "warn" | "danger" | "info";

export interface FlagNotice {
  key:
    | "appliedBefore"
    | "injection"
    | "injectionCleared"
    | "master"
    | "noApplyLink"
    | "lowConfidence"
    | "needsInput"
    | "approveAgain"
    | "companyMissing"
    | "dryRunSettled"
    | "findOnly";
  tone: NoticeTone;
  text: string;
}

/** UC-07 b: Apply stays off for a flagged job until Ba confirms the posting. */
export const isBlockedByInjection = (card: ReviewCard) => card.flags.injectionFlagged && card.job.injectionClearedAt === null;

/** PM S24 "approve again": Apply was denied before it ran (e.g. its token expired). Shared `flags.approveAgain`. */
export const needsReapproval = (card: ReviewCard) => card.flags.approveAgain === true;


/** PM2 S15: the card's dry run finished; approving now (without dry run) applies live with the same CV. */
export const isDryRunSettled = (card: ReviewCard) => card.flags.dryRunSettled === true;

/** W5: a find-only source (Upwork): Approve is refused; Ba applies on the board himself. */
export const isFindOnly = (card: ReviewCard) => card.flags.findOnly === true;

/** "Open on Upwork" (the board of a find-only job). */
export const findOnlyLinkLabel = (card: ReviewCard) => `Open on ${card.job.source === "upwork" || /upwork\.com/i.test(card.job.url ?? "") ? "Upwork" : searchSourceLabel(card.job.source)}`;

/** Toast text for a failed approval; `already_applied` on Approve live means the dry run may really have been sent. */
export function approveErrorText(err: unknown): string {
  if (isApiError(err) && err.code === "already_applied") {
    return "The dry run reported that it submitted, so it may really have been sent. Check it on the Applications screen and mark it failed before approving live.";
  }
  return errorMessage(err);
}

/** The card's warnings, in the order the prototype's banners would stack. */
export function flagNotices(card: ReviewCard): FlagNotice[] {
  const out: FlagNotice[] = [];
  const { job, flags } = card;
  // W5: first, so Ba sees at once that this one is his to apply to.
  if (isFindOnly(card)) out.push({ key: "findOnly", tone: "info", text: FIND_ONLY_NOTE });
  // PM3 S2, §10.2 rule 5: a second application to the same job (Lead or Ba asked to apply again).
  if (flags.appliedBefore) {
    const before = flags.appliedBefore;
    out.push({
      key: "appliedBefore",
      tone: "warn",
      text: `You applied to this job before (${formatDateTime(before.at)}, ${statusMeta(before.status).label}). Approving sends a second application to the same job.`,
    });
  }
  if (flags.injectionFlagged && job.injectionClearedAt === null) {
    out.push({
      key: "injection",
      tone: "danger",
      text: "A bot found text in this job post that tries to instruct the bots (possible prompt injection). Apply stays off for this job until you check the posting and confirm it is safe.",
    });
  } else if (job.injectionFlagged && job.injectionClearedAt !== null) {
    out.push({ key: "injectionCleared", tone: "info", text: "You checked the flagged posting and confirmed it is safe; Apply is enabled for this job." });
  }
  if (needsReapproval(card)) {
    out.push({
      key: "approveAgain",
      tone: "info",
      text: "The last approval expired or was refused before Apply ran. Approving again issues a new token for the same application.",
    });
  }
  if (isDryRunSettled(card)) {
    out.push({
      key: "dryRunSettled",
      tone: "info",
      text: "The dry run of this card has finished; its screenshots are on the Applications screen. Approve live to send it for real with the same CV.",
    });
  }
  if (card.flags.companyMissing) {
    out.push({ key: "companyMissing", tone: "warn", text: "Company research failed · continuing without it. CV tailored this CV without a company profile." });
  }
  if (flags.masterChanged) out.push({ key: "master", tone: "warn", text: "Your master CV changed after this CV was made. Regenerate it with Request changes?" });
  if (flags.noApplyLink) out.push({ key: "noApplyLink", tone: "info", text: "No apply link was found for this JD, so Approve only produces the PDF." });
  if (flags.lowConfidenceCompany) {
    out.push({ key: "lowConfidence", tone: "warn", text: `Little public information about ${card.company?.name ?? job.company}: the company profile is low confidence.` });
  }
  if (flags.needsInput) out.push({ key: "needsInput", tone: "warn", text: "CV needs your input: answer the question below in Master CV, or approve without it." });
  return out;
}

export function approveLabel(card: ReviewCard): string {
  if (card.flags.noApplyLink) return "Approve (PDF only)";
  if (needsReapproval(card)) return "Approve again & submit";
  if (isDryRunSettled(card)) return "Approve live & submit";
  return card.flags.qaPassed ? "Approve & submit" : "Approve anyway & submit";
}

/** UC-08 b: an empty intro means Apply writes one from the master CV. */
export const introPayload = (text: string): string | null => text.trim() || null;

export const cvName = (option: CvOption) => option.pdf?.filename ?? `${option.cvVersion.figmaFrameName}.pdf`;

/** "Asks for GraphQL — …" → "Gap: asks for GraphQL — …" (acronyms keep their case). */
export function gapText(gap: string): string {
  if (/^gap:/i.test(gap)) return gap;
  return `Gap: ${/^[A-Z][a-z]+(\s|$)/.test(gap) ? gap.charAt(0).toLowerCase() + gap.slice(1) : gap}`;
}

export const languageLabel = (lang: string) => (lang === "vi" ? "CV tiếng Việt" : "CV English");

const KIND: Record<string, string> = { product: "product company", outsource: "outsourcing company", mixed: "product + outsourcing", unknown: "company" };

/** "Fintech product company, ~250 people. Culture: ownership, code review heavy. Benefits: …" (prototype). */
export function companySummary(company: ReviewCard["company"]): string {
  const p = company?.profile;
  if (!p) return "No company profile yet.";
  const kind = KIND[p.productOrOutsource]!;
  const what = !p.industry ? kind : p.productOrOutsource === "mixed" ? `${p.industry} (${kind})` : `${p.industry} ${kind}`;
  const head = [what, p.size].filter(Boolean).join(", ");
  const parts = [`${head.charAt(0).toUpperCase()}${head.slice(1)}.`];
  if (p.culture.length) parts.push(`Culture: ${p.culture.join(", ")}.`);
  if (p.benefits.length) parts.push(`Benefits: ${p.benefits.join(", ")}.`);
  if (p.reviewsSummary) parts.push(p.reviewsSummary);
  return parts.join(" ");
}
