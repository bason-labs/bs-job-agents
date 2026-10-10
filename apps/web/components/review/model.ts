// Pure logic behind a review card (§11 Review queue; UC-07..10; PM S24): copy for the job line,
// QA rounds, flags and the approve button.
import { QA_MAX_ROUNDS, type CvVersion, type Job, type QaReviewRecord, type ReviewCard } from "@bs-job-agents/shared";

export type CvOption = ReviewCard["cvOptions"][number];

const SOURCE_LABELS: Record<string, string> = {
  topcv: "TopCV",
  itviec: "ITviec",
  linkedin: "LinkedIn",
  career_site: "Career site",
  link: "Pasted link",
  file: "Uploaded file",
};

export const sourceLabel = (source: string) => SOURCE_LABELS[source] ?? source;

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
  key: "injection" | "injectionCleared" | "master" | "noApplyLink" | "lowConfidence" | "needsInput" | "reapproval";
  tone: NoticeTone;
  text: string;
}

/** UC-07 b: Apply stays off for a flagged job until Ba confirms the posting. */
export const isBlockedByInjection = (card: ReviewCard) => card.flags.injectionFlagged && card.job.injectionClearedAt === null;

/** `reapproval` is not in the shared flags yet (W3a/F3 handoff); read it when the server sends it. */
export const needsReapproval = (card: ReviewCard) => (card.flags as ReviewCard["flags"] & { reapproval?: boolean }).reapproval === true;

/** The card's warnings, in the order the prototype's banners would stack. */
export function flagNotices(card: ReviewCard): FlagNotice[] {
  const out: FlagNotice[] = [];
  const { job, flags } = card;
  if (flags.injectionFlagged && job.injectionClearedAt === null) {
    out.push({
      key: "injection",
      tone: "danger",
      text: "QA found text in this job post that tries to instruct the bots (possible prompt injection). Apply stays off for this job until you check the posting and confirm it is safe.",
    });
  } else if (job.injectionFlagged && job.injectionClearedAt !== null) {
    out.push({ key: "injectionCleared", tone: "info", text: "You checked the flagged posting and confirmed it is safe; Apply is enabled for this job." });
  }
  if (needsReapproval(card)) {
    out.push({
      key: "reapproval",
      tone: "info",
      text: "The last approval expired or was refused before Apply ran. Approving again issues a new token for the same application.",
    });
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
