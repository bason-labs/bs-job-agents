// The DOM surface the source parsers use (W4a). Structural, so the orchestrator needs no DOM library
// at runtime: tests pass a jsdom document, and the same selectors are the "observed 2026-10" hints
// in bots/research/skills/source-*/SKILL.md.
import { parseSalary } from "../salary.js";
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
  /** The first location's region (or locality). */
  region: string | null;
  /** Every location's region (or locality), in order, without repeats. */
  regions: string[];
  /** jobLocationType TELECOMMUTE: the posting says it is remote. */
  remote: boolean;
  salaryText: string | null;
}

/** The objects in one JSON-LD value: an array's items, or the value and its @graph. */
function ldItems(data: unknown): Record<string, unknown>[] {
  const items = Array.isArray(data) ? data : [data, ...(((data as { "@graph"?: unknown[] } | null)?.["@graph"] ?? []) as unknown[])];
  return items.filter((i): i is Record<string, unknown> => typeof i === "object" && i !== null && !Array.isArray(i));
}

/** Does a JSON-LD object have this @type (a string or a list)? */
export function hasLdType(item: Record<string, unknown>, type: string): boolean {
  const t = item["@type"];
  return t === type || (Array.isArray(t) && t.includes(type));
}

/** Every JSON-LD object of the given parsed script contents (unparseable scripts were skipped by the caller). */
export function ldObjects(blocks: readonly unknown[]): Record<string, unknown>[] {
  return blocks.flatMap(ldItems);
}

/**
 * The parsed JSON-LD script blocks of an HTML string, without a DOM (the board-API mappers get raw
 * HTML). A block that is not valid JSON is skipped.
 */
export function ldJsonBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  for (const m of html.matchAll(/<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    try {
      out.push(JSON.parse(m[1]!));
    } catch {
      // not JSON: skipped, like jobPostingLd does
    }
  }
  return out;
}

/**
 * A salary text worth keeping: an amount, or "negotiable" ("Thoả thuận"). A placeholder without
 * either (ITviec's hidden salary for a guest: "You'll love it") is no salary.
 */
function salaryShown(text: string | null): string | null {
  return text !== null && parseSalary(text) !== null ? text : null;
}

/** The fields of a schema.org JobPosting object. */
export function jobPostingFields(posting: Record<string, unknown>): JobPostingLd {
  const str = (v: unknown): string | null => (typeof v === "string" && cleanText(v) ? cleanText(v) : typeof v === "number" ? String(v) : null);
  const org = posting.hiringOrganization as Record<string, unknown> | undefined;
  const locations = (Array.isArray(posting.jobLocation) ? posting.jobLocation : posting.jobLocation ? [posting.jobLocation] : []) as ({ address?: Record<string, unknown> } | null)[];
  const regions = [...new Set(locations.map((l) => str(l?.address?.addressRegion) ?? str(l?.address?.addressLocality)).filter((r): r is string => r !== null))];
  const salary = posting.baseSalary as { value?: Record<string, unknown> } | undefined;
  const locationType = Array.isArray(posting.jobLocationType) ? posting.jobLocationType : [posting.jobLocationType];
  return {
    title: str(posting.title),
    company: str(org?.name),
    datePosted: str(posting.datePosted),
    description: typeof posting.description === "string" ? htmlToText(posting.description) || null : null,
    region: regions[0] ?? null,
    regions,
    remote: locationType.some((t) => typeof t === "string" && t.toUpperCase() === "TELECOMMUTE"),
    salaryText: salaryShown(str(salary?.value?.value)),
  };
}

/** The first JobPosting among parsed JSON-LD blocks, if any. */
export function findJobPosting(blocks: readonly unknown[]): JobPostingLd | null {
  const posting = ldObjects(blocks).find((i) => hasLdType(i, "JobPosting"));
  return posting ? jobPostingFields(posting) : null;
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
    const found = findJobPosting([data]);
    if (found) return found;
  }
  return null;
}
