// The DOM surface the source parsers use (W4a). Structural, so the orchestrator needs no DOM library
// at runtime: tests pass a jsdom document, and the same selectors are the "observed 2026-10" hints
// in bots/research/skills/source-*/SKILL.md.
import { cleanText } from "../text.js";

export interface DomNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly textContent: string | null;
  readonly childNodes: ArrayLike<DomNode>;
}

export interface DomElement extends DomNode {
  getAttribute(name: string): string | null;
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
}

/** A document or an element: anything we can query. */
export interface DomRoot {
  readonly title?: string;
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
}

export function all(root: DomRoot, selector: string): DomElement[] {
  return Array.from(root.querySelectorAll(selector));
}

/** Clean text of the first match, or null when missing or blank. */
export function textOf(root: DomRoot, selector: string): string | null {
  const t = cleanText(root.querySelector(selector)?.textContent);
  return t || null;
}

export function attrOf(root: DomRoot, selector: string, name: string): string | null {
  const v = root.querySelector(selector)?.getAttribute(name)?.trim();
  return v || null;
}

/** The page <title>, or the <title> element's text when the root is not a document. */
export function pageTitle(root: DomRoot): string {
  return cleanText(root.title ?? root.querySelector("title")?.textContent);
}

const BLOCK = new Set([
  "P", "DIV", "SECTION", "ARTICLE", "UL", "OL", "LI", "BR", "H1", "H2", "H3", "H4", "H5", "H6", "TR", "TABLE", "HEADER", "FOOTER", "BLOCKQUOTE", "PRE", "DL", "DT", "DD",
]);
const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "BUTTON"]);

/**
 * Readable text of an element: one line per block (paragraph, heading, list item), list items
 * prefixed "- ", blank lines dropped. This is what a JD's "full text" looks like in JobCandidate.
 */
export function blockText(el: DomNode): string {
  const parts: string[] = [];
  const walk = (n: DomNode) => {
    if (n.nodeType === 3) {
      parts.push(n.textContent ?? "");
      return;
    }
    if (n.nodeType !== 1 && n.nodeType !== 9 && n.nodeType !== 11) return;
    const name = n.nodeName.toUpperCase();
    if (SKIP.has(name)) return;
    const block = BLOCK.has(name);
    if (block) parts.push("\n");
    if (name === "LI") parts.push("- ");
    for (const c of Array.from(n.childNodes)) walk(c);
    if (block) parts.push("\n");
  };
  walk(el);
  return parts
    .join("")
    .split("\n")
    .map((l) => cleanText(l))
    .filter((l) => l && l !== "-")
    .join("\n");
}

/** HTML in a string (e.g. a JSON-LD description) → the same readable text, without a DOM. */
export function htmlToText(html: string): string {
  const decoded = html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "\n- ")
    .replace(/<\s*\/?\s*(p|div|ul|ol|li|h[1-6]|tr|section|article)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)));
  return decoded
    .split(/\r?\n/)
    .map((l) => cleanText(l))
    .filter((l) => l && l !== "-")
    .join("\n");
}

export interface JobPostingLd {
  title: string | null;
  company: string | null;
  datePosted: string | null;
  description: string | null;
  region: string | null;
  salaryText: string | null;
}

/** The schema.org JobPosting a page embeds (TopCV, ITviec and many career sites do), if any. */
export function jobPostingLd(root: DomRoot): JobPostingLd | null {
  for (const s of all(root, 'script[type="application/ld+json"]')) {
    let data: unknown;
    try {
      data = JSON.parse(s.textContent ?? "");
    } catch {
      continue;
    }
    const items = (Array.isArray(data) ? data : [data, ...((data as { "@graph"?: unknown[] })?.["@graph"] ?? [])]) as Record<string, unknown>[];
    const posting = items.find((i) => i && (i["@type"] === "JobPosting" || (Array.isArray(i["@type"]) && i["@type"].includes("JobPosting"))));
    if (!posting) continue;
    const str = (v: unknown): string | null => (typeof v === "string" && cleanText(v) ? cleanText(v) : typeof v === "number" ? String(v) : null);
    const org = posting.hiringOrganization as Record<string, unknown> | undefined;
    const loc = (Array.isArray(posting.jobLocation) ? posting.jobLocation[0] : posting.jobLocation) as { address?: Record<string, unknown> } | undefined;
    const salary = posting.baseSalary as { value?: Record<string, unknown> } | undefined;
    return {
      title: str(posting.title),
      company: str(org?.name),
      datePosted: str(posting.datePosted),
      description: typeof posting.description === "string" ? htmlToText(posting.description) || null : null,
      region: str(loc?.address?.addressRegion) ?? str(loc?.address?.addressLocality),
      salaryText: str(salary?.value?.value),
    };
  }
  return null;
}
