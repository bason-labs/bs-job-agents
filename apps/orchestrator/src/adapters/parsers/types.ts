// What a source parser reads off a page, before normalisation (W4a).
import type { DomRoot } from "./dom.js";

export interface RawCard {
  href: string | null;
  title: string | null;
  company: string | null;
  location: string | null;
  salaryText: string | null;
  /** The posted label as shown ("Đăng 3 ngày trước", "5 days ago"). */
  postedText: string | null;
  /** A machine-readable date next to it (<time datetime>), when the page has one. */
  postedDate: string | null;
  /** "At office" / "Hybrid" / "Remote" as shown. */
  workModeText: string | null;
}

export interface RawJob {
  title: string | null;
  company: string | null;
  location: string | null;
  salaryText: string | null;
  postedText: string | null;
  postedDate: string | null;
  workModeText: string | null;
  jdText: string | null;
  /** <link rel=canonical> or similar. */
  canonicalHref: string | null;
}

export interface SourceParser {
  /** The job-card selector (named in "adapter broken" reasons). */
  readonly cardSelector: string;
  /** The JD block selector (named in "adapter broken" reasons). */
  readonly jdSelector: string;
  /** The result count the page states ("14 việc làm", "35 jobs"), or null when it states none. */
  resultCount(root: DomRoot): number | null;
  cards(root: DomRoot): RawCard[];
  job(root: DomRoot): RawJob;
}

/** "14", "1,040", "1.040" → number. */
export function countFrom(text: string | null | undefined, re: RegExp): number | null {
  const m = re.exec(text ?? "");
  if (!m) return null;
  const n = Number(m[1]!.replace(/[.,]/g, ""));
  return Number.isFinite(n) ? n : null;
}
