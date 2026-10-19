// CV guidance (§5.4 step 1): the main text of a fetched HTML page, without a DOM library. The page is
// untrusted data: this only reduces it to plain text (no markup, no links, no scripts) so it can be
// hashed for change detection and quoted to the tool-less extraction task. Same output shape as
// adapters/parsers/dom.ts htmlToText (one line per block), which it reuses.
import { htmlToText } from "../parsers/dom.js";
import { cleanText } from "../text.js";

/** Elements that are never the article: scripts, page chrome, forms and embedded media. */
const DROP = ["script", "style", "noscript", "template", "svg", "iframe", "form", "nav", "header", "footer", "aside", "button", "select", "picture", "video", "audio", "canvas"];

/** At most this much text per page reaches the extraction task (the batch cap is in guidance-refresh). */
export const PAGE_TEXT_MAX_CHARS = 40_000;

function dropElements(html: string): string {
  let out = html.replace(/<!--[\s\S]*?-->/g, " ");
  for (const tag of DROP) {
    // Non-greedy pairs, repeated for nesting; a stray opening tag alone is removed by htmlToText.
    const re = new RegExp(`<\\s*${tag}\\b[^>]*>[\\s\\S]*?<\\s*/\\s*${tag}\\s*>`, "gi");
    for (let i = 0; i < 4 && re.test(out); i++) out = out.replace(re, " ");
  }
  return out;
}

/** The inner HTML of the largest `<article>` or `<main>` (by text length), else the body. */
function mainPart(html: string): string {
  const candidates: string[] = [];
  for (const tag of ["article", "main"]) {
    for (const m of html.matchAll(new RegExp(`<\\s*${tag}\\b[^>]*>([\\s\\S]*?)<\\s*/\\s*${tag}\\s*>`, "gi"))) candidates.push(m[1]!);
  }
  const textLength = (s: string) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").length;
  const best = candidates.sort((a, b) => textLength(b) - textLength(a))[0];
  if (best && textLength(best) >= 500) return best;
  const body = /<\s*body\b[^>]*>([\s\S]*?)(?:<\s*\/\s*body\s*>|$)/i.exec(html);
  const part = body ? body[1]! : html;
  // No article element: the page's own heading starts the text (menus before it are dropped).
  const h1 = part.search(/<\s*h1\b/i);
  return h1 > 0 && textLength(part.slice(h1)) >= 500 ? part.slice(h1) : part;
}

/** Decode the remaining numeric and common named entities htmlToText leaves (&#x27;, &rsquo; …). */
function decodeEntities(s: string): string {
  const named: Record<string, string> = { rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…", bull: "•", middot: "·", copy: "©", reg: "®", trade: "™" };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => safeCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n: string) => named[n.toLowerCase()] ?? m);
}

function safeCodePoint(n: number): string {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : " ";
}

/** Control characters (NUL, ESC …) except newline and tab. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** The page's `<title>`, plain text, at most 200 characters (SEC-26). */
export function htmlTitle(html: string): string | null {
  const m = /<\s*title\b[^>]*>([\s\S]*?)<\s*\/\s*title\s*>/i.exec(html);
  const t = m ? cleanText(decodeEntities(htmlToText(m[1]!)).replace(CONTROL, "")) : "";
  return t ? t.slice(0, 200) : null;
}

/** The readable main text of an HTML page: one line per block, no markup, capped. */
export function mainText(html: string): string {
  const text = decodeEntities(htmlToText(mainPart(dropElements(html)))).replace(CONTROL, "");
  return text.length > PAGE_TEXT_MAX_CHARS ? text.slice(0, PAGE_TEXT_MAX_CHARS) : text;
}
