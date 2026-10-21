// Skill self-repair (SEC-9, QA H2): the allowlist part of the skill screen. A repair may change only
// the layout of a board, so:
//   1. Frozen sections. Everything except the layout sections is byte-identical to the skill in force:
//      the front matter, title and intro (with the Read-only rule), every `## ` heading line, and the
//      bodies of the limits, writing, remote-rules, blocked, layout-changed and no-results sections.
//      The layout sections are "Search URL", "Listing page", "Job page" (and the career site's
//      "Finding the openings"): URL patterns, selector and landmark hints, pagination notes.
//   2. A constrained grammar for every line a draft adds or changes in a layout section (a line
//      identical to one of the same section in force was reviewed already and is kept as is):
//      - a bullet ("- ") or a plain text line; no heading, table, quote, rule or front-matter line;
//      - `code` is a CSS selector, landmark text, or a URL path or pattern on the board's hosts with
//        query keys and <placeholders> the skill in force already uses, and no apply, save, follow,
//        login or submit segment (EN and VI);
//      - "quoted" text is a short page label;
//      - every other word comes from a small vocabulary of descriptive words and the read-only verbs
//        (read, open, find, look, scroll, extract, copy, wait, skip, use, go to, see, and Vietnamese
//        equivalents), plus the words of the same section in force, minus a list of action words;
//      - table rows with each cell held to the same grammar; selectors need a selector mark, one
//        token or at most 2 words (other text in backticks is held to the vocabulary);
//      - no limit number (pages, searches, views, jobs, ?page=) above the source's limits, no tool
//        outside the grant, no "open" of a button or an apply/save/login label, no host (dotted name under a public
//        suffix, selector look-alikes included) off the board's hosts.
//   3. A character set: printable letters, digits, punctuation, symbols, the space and the newline
//      (no tag characters, variation selectors, fillers, zero-width or bidi controls, tabs or NBSP).
import { isPublicHost } from "../common/host.js";
import { hostWithin, hostsInText } from "../common/text-hygiene.js";

export type AllowlistRule = "charset" | "frozen" | "grammar" | "off_host" | "tool" | "action" | "limit";
export type AllowlistResult = { ok: true } | { ok: false; rule: AllowlistRule; reason: string };

export interface AllowlistContext {
  hosts: readonly string[];
  /** Query keys the board's access record lists (its endpoints' `query`). */
  queryKeys?: readonly string[];
  /** Tool names the bot could name: none outside `granted` may appear in a changed line. */
  tools: readonly string[];
  /** The tools the source's grant gives (get_page_text, find …): a changed line may name them. */
  granted?: readonly string[];
  /** The largest number a changed line may state (the source's highest limit). */
  maxNumber: number;
}

const fail = (rule: AllowlistRule, reason: string): AllowlistResult => ({ ok: false, rule, reason });

/** Layout sections a repair may edit, by heading (without its number). */
export const EDITABLE_SECTIONS: readonly RegExp[] = [/^search url\b/i, /^listing page\b/i, /^job page\b/i, /^finding the openings\b/i];

// Hangul and other fillers that are letters to Unicode but print nothing; the braille blank.
const FILLERS = new Set([0x115f, 0x1160, 0x3164, 0xffa0, 0x2800, 0x17b4, 0x17b5]);

/** The first character outside the allowed set, as U+XXXX, or null. */
export function disallowedCharacter(text: string): string | null {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (ch === "\n" || ch === " ") continue;
    const ok = !FILLERS.has(cp) && (/[\p{L}\p{N}\p{P}\p{S}]/u.test(ch) || (cp >= 0x300 && cp <= 0x36f));
    if (!ok) return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return null;
}

interface Parsed {
  preamble: string;
  sections: { heading: string; name: string; lines: string[] }[];
}

export function parseSkill(md: string): Parsed {
  const lines = md.split("\n");
  const first = lines.findIndex((l) => l.startsWith("## "));
  const preamble = (first < 0 ? lines : lines.slice(0, first)).join("\n");
  const sections: Parsed["sections"] = [];
  if (first >= 0) {
    for (const line of lines.slice(first)) {
      if (line.startsWith("## ")) sections.push({ heading: line, name: line.slice(3).replace(/^\d+\.\s*/, "").trim(), lines: [] });
      else sections.at(-1)!.lines.push(line);
    }
  }
  return { preamble, sections };
}

const isEditable = (name: string): boolean => EDITABLE_SECTIONS.some((re) => re.test(name));
const trimEnd = (lines: string[]): string => lines.join("\n").replace(/\s+$/, "");

/** Read-only verbs and descriptive words a changed line may use (EN and VI syllables). */
const VOCABULARY = new Set(
  `a an the and or of in on at to for with by from into onto under over above below before after as is are was be been being it its this that these those
  each every any all both either one two three first second last next previous prior other another only also not no nor if when where while then else so than
  until per via e g eg i ie etc may might can could usually often sometimes always now still here there same new old more most less least just about
  very much many few several some such like instead otherwise yet once again up down out off back forward you they them their which what how since during
  page pages pager pagination paginated paging list lists listing listings result results search searches card cards item items row rows entry entries
  link links title titles subtitle company companies employer salary salaries location locations city cities date dates time posted posting postings job jobs
  description descriptions section sections block blocks header headers heading headings label labels tag tags chip chips button buttons tab tabs panel panels
  column columns main text texts field fields count counts number numbers url urls path paths pattern slug slugs id ids query parameter parameters
  element elements container wrapper attribute attributes class classes selector selectors sidebar footer logo badge icon image images
  mode work remote hybrid office onsite full jd short long empty null value values shown shows show showing states state says holds gives contains contain
  has have had inside outside near top bottom left right middle lazy infinite older newer more loads loaded loading appear appears visible hidden
  name names format content area region filter filters sort sorted order line lines word words case lower upper lowercase uppercase ascii dash dashes slash
  part parts start end begins ends whole single multiple same group grouped preview detail details note notes meta tagline seniority level type types
  english vietnamese guest guests board boards site page's card's job's
  read reads reading open opens opening find finds finding look looks looking scroll scrolls scrolling extract extracts copy copies wait waits skip skips
  use uses using go goes see sees get gets keep keeps take takes stop stops
  xem mở đọc tìm cuộn bỏ qua chờ dùng sử đến đi sao chép trích lấy trang danh sách việc làm tiêu đề công ty lương địa điểm mô tả và của các có không kết quả
  tiếp theo trước sau mỗi một hai trong ngoài trên dưới thẻ nút nhãn mục phần`
    .split(/\s+/)
    .filter(Boolean),
);

/** Action, override and data words a changed line never uses, whatever the section in force says. */
const DENIED = new Set(
  `click clicks clicking clicked press presses tap taps hit apply applies applying applied application applications submit submits submitting save saves saving
  follow follows following message messages messaging connect connects bid bids buy buys purchase proposal proposals login logon log logs sign signs signin
  signup register upload uploads send sends post posts fill fills enter paste write writes run runs execute ignore ignores forget disregard bypass override
  replace rule rules instruction instructions schema prompt prompts memory self passed pass true false mark marks report reveal share email
  e-mail contact reach recruiter recruiters hesitate proceed cap uncapped unlimited limit limits password passwords cookie cookies token tokens account
  accounts profile accept allow solve captcha javascript script tool tools bash cv resume download downloads install delete remove edit
  nhấn bấm nộp đăng nhập ký ứng tuyển lưu gửi dõi tải hãy liên hệ xóa`
    .split(/\s+/)
    .filter(Boolean),
);

/** URL path pieces of a write, account or saved-jobs action (EN and VI, accents dropped); never in a changed URL. */
const PATH_DENIED = new Set(
  `apply applies application applications ung tuyen nop ho so save saved luu tin follow login logon signin signup sign in up dang nhap ky register submit
  proposal proposals message messages messaging connect invite logout account accounts settings checkout payment pay bid upload delete edit
  bookmark bookmarks bookmarked favorite favorites favourite favourites wishlist`
    .split(/\s+/)
    .filter(Boolean),
);
/** Multi-piece saved-jobs paths ("my-jobs", "việc làm đã lưu"). */
const PATH_DENIED_PHRASES = [/\bmy[-_ ]?jobs\b/, /\bviec[-_ ]?lam[-_ ]?da[-_ ]?luu\b/, /\bda[-_ ]?luu\b/];

/**
 * Action words inside any `code` span (selectors and their attribute values included, QA final
 * round): `[onclick=apply]`, `log in`, `đăng nhập` are instructions, not page parts. Matched on the
 * accent-free skeleton, as whole words or (multi-word) phrases.
 */
const CODE_DENIED_WORDS = new Set(
  `click clicks onclick apply applies applying applied application applications submit submits save saves saving saved follow follows following
  message messages messaging connect bid buy purchase proposal proposals login logon logout signin signup register upload uploads send fill paste
  write run execute ignore forget override bypass delete remove edit download javascript script bookmark bookmarks wishlist favorite favourite`
    .split(/\s+/)
    .filter(Boolean),
);
const CODE_DENIED_PHRASES = [/\blog in\b/, /\bsign (?:in|up|on)\b/, /\bmy jobs\b/, /\bdang (?:nhap|ky)\b/, /\bung tuyen\b/, /\bnop ho so\b/, /\bluu tin\b/, /\btheo doi\b/, /\bgui (?:ho so|cv|don)\b/, /\b(?:nhan|bam) (?:nut|vao)\b/, /\bluu viec\b/];

/** The action word a code span holds, or null. */
export function codeActionWord(code: string): string | null {
  const words = pathSkeleton(code).split(/[^a-z0-9]+/).filter(Boolean);
  const word = words.find((w) => CODE_DENIED_WORDS.has(w));
  if (word) return word;
  const joined = ` ${words.join(" ")} `;
  return CODE_DENIED_PHRASES.map((re) => re.exec(joined)?.[0]).find(Boolean) ?? null;
}

/** Query keys that page through results: their value is a count, held to the source's limits. */
const PAGING_KEYS = new Set(["page", "p", "pg", "start", "offset", "limit", "count", "size", "per_page", "pagesize", "page_size", "num"]);

// Cyrillic and Greek letters that look like Latin ones (their skeleton for the path check).
const HOMOGLYPHS: Record<string, string> = {
  а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x", і: "i", ј: "j", ѕ: "s", ԁ: "d", ӏ: "l", һ: "h", ԛ: "q", ԝ: "w", ɡ: "g", ɑ: "a",
  α: "a", ο: "o", ρ: "p", ν: "v", κ: "k", ι: "i", τ: "t", υ: "u", χ: "x", ε: "e", ѵ: "v", ꞵ: "b",
};

/** A path as a browser would read it: percent-decoded, NFKC, homoglyphs to their skeleton, accents dropped, lowercase. */
export function pathSkeleton(path: string): string {
  let out = path;
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(out);
      if (next === out) break;
      out = next;
    } catch {
      break;
    }
  }
  out = out.normalize("NFKC").toLowerCase();
  out = [...out].map((c) => HOMOGLYPHS[c] ?? c).join("");
  return out.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d");
}

const CODE = /`([^`\n]*)`/g;
const QUOTE = /"([^"\n]*)"|“([^”\n]*)”/g;
const SELECTOR = /^[\p{L}\p{N} .#[\]="'*^$|~>+:(),_-]+$/u;
const HTML_TAGS =
  "a|abbr|article|aside|b|body|button|dd|div|dl|dt|em|footer|form|h[1-6]|header|i|img|input|label|li|main|nav|ol|p|section|small|span|strong|table|tbody|td|th|time|tr|ul";
/** tag.class or tag#id selectors (`a.company`, `h3.title`), their class part after the tag. */
const TAG_SELECTOR = new RegExp(`(?<![\\w.#-])(?:${HTML_TAGS})((?:[.#][\\w-]+)+)`, "gi");

/** Placeholders (<role-slug>) and query keys (?page=, &f_WT=) the skill in force already uses. */
function vocabularyOf(text: string): { placeholders: Set<string>; keys: Set<string> } {
  return {
    placeholders: new Set([...text.matchAll(/<[^<>\n]{1,30}>/g)].map((m) => m[0])),
    keys: new Set([...text.matchAll(/[?&]([A-Za-z_][\w-]*)=/g)].map((m) => m[1]!.toLowerCase())),
  };
}

function checkUrl(url: string, ctx: AllowlistContext, known: { placeholders: Set<string>; keys: Set<string> }): AllowlistResult {
  const plain = pathSkeleton(url);
  if (/\b(?:javascript|data|vbscript|file):/i.test(plain)) return fail("action", `it holds a script or file URL (${url})`);
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/([^/?#\s]+)/i.exec(url);
  if (scheme) {
    if (scheme[1]!.toLowerCase() !== "https") return fail("off_host", `it names a non-https URL (${url})`);
    if (!hostWithin(scheme[2]!.replace(/:\d+$/, ""), ctx.hosts)) return fail("off_host", `it names ${scheme[2]}, outside the source's hosts (${ctx.hosts.join(", ")})`);
  }
  const path = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#\s]+/i, "");
  for (const ph of path.match(/<[^<>]*>/g) ?? []) {
    if (!known.placeholders.has(ph)) return fail("grammar", `it uses the placeholder ${ph}, which the skill in force does not`);
  }
  const skeleton = pathSkeleton(path.replace(/<[^<>]*>/g, " "));
  const pieces = skeleton.split(/[^a-z0-9]+/).filter(Boolean);
  const denied = pieces.find((p) => PATH_DENIED.has(p)) ?? PATH_DENIED_PHRASES.map((re) => re.exec(skeleton)?.[0]).find(Boolean);
  if (denied) return fail("action", `it names a URL with "${denied}" in it (${url})`);
  if (/[^\x20-\x7e]/.test(skeleton)) return fail("grammar", `a URL path holds a letter outside plain ASCII (${url})`);
  const allowedKeys = new Set([...known.keys, ...(ctx.queryKeys ?? []).map((k) => k.toLowerCase())]);
  for (const m of skeleton.matchAll(/(?:^|[?&])([^=&?#\s]+)=([^&#\s]*)/g)) {
    const key = m[1]!;
    if (!allowedKeys.has(key)) return fail("grammar", `it uses the query key "${key}", which the skill in force does not`);
    if (PAGING_KEYS.has(key) && /^\d+$/.test(m[2]!) && Number(m[2]) > ctx.maxNumber) return fail("limit", `it pages to ${key}=${m[2]}, above the source's limits`);
  }
  return { ok: true };
}

const looksLikeUrl = (s: string): boolean => /^(?:[a-z][a-z0-9+.-]*:|\/|\?|&)/i.test(s) || s.includes("/") || /[?&][\w-]+=/.test(s);

/** A code span that is a CSS selector: selector characters, and a selector mark, one token or at most 2 words. */
function isSelector(code: string): boolean {
  if (!SELECTOR.test(code) || code.length > 80) return false;
  return /[.#[>:=]/.test(code) || code.split(/\s+/).length <= 2;
}

function toolIn(text: string, ctx: AllowlistContext): string | null {
  if (/\bmcp__/i.test(text)) return "mcp__…";
  const granted = new Set((ctx.granted ?? []).map((t) => t.toLowerCase()));
  for (const tool of ctx.tools) {
    if (granted.has(tool.toLowerCase())) continue;
    const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = tool.includes("_") || /^(?:bash|webfetch|websearch|notebookedit|multiedit|todowrite|computer)$/i.test(tool) ? new RegExp(`\\b${escaped}\\b`, "i") : new RegExp(`\`${escaped}\``, "i");
    if (re.test(text)) return tool;
  }
  return null;
}

/** Hosts a line names. In code, a tag.class selector (`a.company`) is no host unless its class part is a registrable name itself. */
function hostsOfLine(line: string): string[] {
  const text = line.replace(CODE, (_m, code: string) =>
    ` ${code.replace(TAG_SELECTOR, (sel: string, classes: string) => {
      const rest = classes.replace(/^[.#]/, "").replace(/#/g, ".");
      return isPublicHost(rest) ? ` ${rest} ` : " ";
    })} `,
  );
  return hostsInText(text);
}

/** Buttons and links named for an outward action (EN and VI): the bot never opens them. */
const ACTION_LABEL = /\b(?:apply|easy apply|submit|save|saved|sign ?in|sign ?up|log ?in|login|register|follow|connect|message|bid|proposal|bookmark)\b|ứng tuyển|nộp|lưu|đăng nhập|đăng ký|theo dõi|gửi/i;

type Known = { placeholders: Set<string>; keys: Set<string> };

/** Words a number states a limit in (pages, searches, views, jobs …). */
const LIMIT_NOUNS = /^\s*(?:\S+\s+)?(?:pages?|searches|search|views?|page views|jobs?|postings?|results?|cards?|listings?|links?|tabs?|scrolls?|times)\b/i;

/** The words, numbers, labels, code spans and URLs of one line or table cell. */
function checkContent(text: string, line: string, ctx: AllowlistContext, words: Set<string>, known: Known): AllowlistResult {
  if ((text.match(/`/g) ?? []).length % 2 !== 0) return fail("grammar", "a changed line has an unclosed `code` span");
  const tool = toolIn(text, ctx);
  if (tool) return fail("tool", `it names the tool ${tool}`);
  const outside = hostsOfLine(text).filter((h) => !hostWithin(h, ctx.hosts));
  if (outside.length > 0) return fail("off_host", `it names ${outside.join(", ")}, outside the source's hosts (${ctx.hosts.join(", ") || "none"})`);
  // "open" a quoted label for an outward action, or open/use a button.
  for (const m of text.matchAll(/\b(?:open|opens|go to|use|tap)\b[^.;|]{0,40}?(?:"([^"\n]*)"|“([^”\n]*)”)/gi)) {
    if (ACTION_LABEL.test(m[1] ?? m[2] ?? "")) return fail("action", `it tells the bot to open "${m[1] ?? m[2]}"`);
  }
  if (/\b(?:open|opens|go to|use|tap)\b[^.;|]{0,60}\b(?:buttons?|nút)\b/i.test(text.replace(CODE, " "))) return fail("action", "it tells the bot to open a button");
  const codeText: string[] = [];
  for (const m of text.matchAll(CODE)) {
    const code = m[1]!.trim();
    if (code === "") return fail("grammar", "a changed line has an empty `code` span");
    const action = codeActionWord(code);
    if (action) return fail("action", `\`${code.slice(0, 60)}\` holds the action word "${action}"`);
    if (looksLikeUrl(code)) {
      const r = checkUrl(code, ctx, known);
      if (!r.ok) return r;
    } else if (!isSelector(code)) {
      if (!SELECTOR.test(code)) return fail("grammar", `\`${code.slice(0, 60)}\` is neither a CSS selector, landmark text nor a URL path`);
      // Free text in backticks is held to the same words as the rest of the line.
      codeText.push(code);
    }
  }
  let prose = `${text.replace(CODE, " ")} ${codeText.join(" ")}`;
  for (const m of prose.matchAll(QUOTE)) {
    const label = m[1] ?? m[2] ?? "";
    if (label.length > 60) return fail("grammar", "a quoted page label is longer than 60 characters");
  }
  prose = prose.replace(QUOTE, " ");
  if ((prose.match(/"/g) ?? []).length > 0) return fail("grammar", "a changed line has an unclosed quote");
  if (/\b(?:javascript|data|vbscript):/i.test(prose)) return fail("action", "it holds a script URL");
  for (const m of prose.matchAll(/(?:https?:\/\/|\/)[^\s)|]+/gi)) {
    const r = checkUrl(m[0], ctx, known);
    if (!r.ok) return r;
  }
  prose = prose.replace(/(?:https?:\/\/|\/)[^\s)|]+/gi, " ");
  // Only a number that states a limit (pages, searches, views, jobs) is held to the limits; years and dates are fine.
  for (const m of prose.matchAll(/\d+(?:[.,]\d+)?/g)) {
    const n = Number(m[0].replace(",", "."));
    const after = prose.slice(m.index + m[0].length);
    const before = prose.slice(Math.max(0, m.index - 25), m.index);
    const isLimit = LIMIT_NOUNS.test(after) || /(?:at most|up to|no more than|max(?:imum)?|limit of|top)\s*$/i.test(before);
    const year = /^\d{4}$/.test(m[0]) && n >= 1990 && n <= 2100;
    if (isLimit && !year && n > ctx.maxNumber) return fail("limit", `it states ${m[0]}, above the source's limits`);
  }
  // Opening every link (or page, site) on a page goes beyond a layout hint.
  if (/\b(?:open|opens|visit|go to|read|follow|load)\b[^.;|]{0,25}\b(?:any|every|all|each|other|external)\b[^.;|]{0,25}\b(?:links?|sites?|urls?|domains?|hosts?|websites?)\b/i.test(prose)) {
    return fail("action", `it tells the bot to open every link ("${line.slice(0, 80)}")`);
  }
  for (const raw of prose.toLowerCase().match(/[\p{L}][\p{L}\p{M}'’]*/gu) ?? []) {
    const word = raw.replace(/’/g, "'");
    const bare = word.replace(/'s$/, "");
    if (DENIED.has(word) || DENIED.has(bare)) return fail("action", `it uses "${bare}", an action or rule word a layout hint never needs ("${line.slice(0, 80)}")`);
    if (!words.has(word) && !words.has(bare)) return fail("grammar", `"${raw}" is not a word a layout hint may use ("${line.slice(0, 80)}")`);
  }
  return { ok: true };
}

const TABLE_SEPARATOR = /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/;

/** One added or changed line of a layout section: a bullet, a plain line or a table row. */
function checkLine(line: string, ctx: AllowlistContext, words: Set<string>, known: Known): AllowlistResult {
  if (line.length > 400) return fail("grammar", "a changed line is longer than 400 characters");
  if (/^\s*\|/.test(line)) {
    if (TABLE_SEPARATOR.test(line)) return { ok: true };
    if (!/\|\s*$/.test(line)) return fail("grammar", "a table row must end with |");
    for (const cell of line.trim().slice(1, -1).split("|")) {
      const r = checkContent(cell.trim(), line, ctx, words, known);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  if (/^\s*(?:#|=|>|<|```|-{3,}|\*{3,}|_{3,}|\+ |\* |\d+[.)] )/.test(line) || /^\s*[-=*_]+\s*$/.test(line)) {
    return fail("grammar", `a changed line is not a bullet, a plain line or a table row ("${line.slice(0, 60)}")`);
  }
  return checkContent(line, line, ctx, words, known);
}

/** The words of a section's prose (outside code and quotes), minus the denied ones. */
function sectionWords(lines: readonly string[]): string[] {
  const prose = lines.join("\n").replace(CODE, " ").replace(QUOTE, " ").toLowerCase();
  return (prose.match(/[\p{L}][\p{L}\p{M}'’]*/gu) ?? []).map((w) => w.replace(/’/g, "'")).filter((w) => !DENIED.has(w) && !DENIED.has(w.replace(/'s$/, "")));
}

export function screenSkillAllowlist(md: string, current: string, ctx: AllowlistContext): AllowlistResult {
  const bad = disallowedCharacter(md);
  if (bad) return fail("charset", `it holds the character ${bad}, outside printable letters, digits, punctuation, the space and the newline`);
  const draft = parseSkill(md);
  const now = parseSkill(current.replace(/\r\n?/g, "\n"));
  if (draft.preamble !== now.preamble) return fail("frozen", "it changes the front matter, the title or the Read-only rules (frozen)");
  const headings = (p: Parsed) => p.sections.map((s) => s.heading);
  if (JSON.stringify(headings(draft)) !== JSON.stringify(headings(now))) return fail("frozen", "it adds, drops, renames or reorders a section (frozen)");
  const known = vocabularyOf(current);
  for (const [i, section] of draft.sections.entries()) {
    const was = now.sections[i]!;
    if (!isEditable(section.name)) {
      if (trimEnd(section.lines) !== trimEnd(was.lines)) {
        return fail("frozen", `it changes "${section.name}", which a repair may not change (frozen)`);
      }
      continue;
    }
    const kept = new Set(was.lines);
    const words = new Set([...VOCABULARY, ...sectionWords(was.lines)]);
    for (const line of section.lines) {
      if (line.trim() === "" || kept.has(line)) continue;
      const r = checkLine(line, ctx, words, known);
      if (!r.ok) return r;
    }
  }
  return { ok: true };
}
