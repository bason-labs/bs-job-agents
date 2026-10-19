// CV guidance text policy (§5.5, SEC-22, SEC-23): the evidence match, the content screen (EN and VI
// deny-lists, table-tested in screen.test.ts), the constraint mapping (overriddenBy, set by code)
// and how a fetched page's host, kind and market are classified. Pure.
import { parse } from "tldts";
import { termIn, termsIn } from "../cv-derive/implications.js";
import { capitalisedNames, titlesIn } from "../truth/claims.js";
import type { CvConstraintId, GuidanceMarket, GuidanceSourceKind, GuidanceTopic } from "./schema.js";
import { GUIDANCE_LIMITS } from "./schema.js";

/** For matching only: NFKC, lowercase, curly quotes and dashes made plain, whitespace squashed. */
export function normaliseForMatch(s: string): string {
  return s
    .normalize("NFKC")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP_WORDS = new Set([
  // EN
  "the", "and", "for", "with", "your", "you", "that", "this", "from", "are", "have", "will", "can", "should", "each", "every", "all", "not", "any", "more", "most", "their",
  "them", "they", "our", "its", "into", "about", "when", "what", "which", "who", "how", "than", "then", "also", "only", "use", "using", "but", "was", "were", "has", "had",
  "one", "out", "make", "sure", "way", "get", "may", "might", "just", "like", "such", "these", "those", "there", "here", "own", "very", "much", "many", "some", "help",
  // VI
  "của", "và", "các", "những", "cho", "với", "trong", "được", "này", "một", "là", "có", "không", "khi", "để", "bạn", "nên", "cần", "từ", "theo", "như", "hay", "hoặc", "rất",
  "nhiều", "đã", "sẽ", "đến", "về", "lên", "ra", "vào", "thì", "mà", "cũng", "đó", "nào", "hãy", "phải", "bằng", "trên", "dưới", "người", "việc", "nếu",
]);

/** Content words of a text (case-folded, without stop words): what an overlap is measured on. */
export function contentWords(s: string): Set<string> {
  return new Set(
    normaliseForMatch(s)
      .split(/[^\p{L}\p{N}+#]+/u)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w)),
  );
}

/** At least this much quote (F3): a few words prove nothing about where the advice came from. */
export const EVIDENCE_MIN_CHARS = 40;

/**
 * SEC-23 (F3): the quote is real evidence for the statement: at least 40 characters, inside one
 * content line of the page (the long lines guidanceContentKey keeps: no menus, no spanning
 * paragraphs), and it shares content words with the statement (2, or 1 for a short statement).
 */
export function evidenceInText(quote: string, pageText: string, statement?: string): boolean {
  const q = normaliseForMatch(quote).replace(/^["']+|["'.…]+$/g, "").trim();
  if (q.length < EVIDENCE_MIN_CHARS) return false;
  const lines = pageText.split(/\n/).map(normaliseForMatch).filter((l) => l.length >= 80);
  if (!lines.some((l) => l.includes(q))) return false;
  if (statement === undefined) return true;
  const said = contentWords(statement);
  const quoted = contentWords(q);
  const shared = [...said].filter((w) => quoted.has(w)).length;
  return shared >= (said.size <= 4 ? 1 : 2);
}

/**
 * The text a page's change detection hashes: its long lines (advice paragraphs, not menus, counters
 * or related-article lists), with digits folded so a live counter ("142,789 job seekers") or a
 * date stamp does not count as a change. Unchanged advice → same key → no extraction call.
 */
export function guidanceContentKey(pageText: string): string {
  return pageText
    .split(/\n/)
    .map((l) => normaliseForMatch(l).replace(/\d+/g, "0"))
    .filter((l) => l.length >= 80)
    .join("\n");
}

// ---------------------------------------------------------------- content screen (SEC-22)

const URL_IN_TEXT = /https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|vn|co|ai|app|dev|me|info|example)\b/i;

/** Instructions aimed at the bot or its configuration (prompt injection). */
const BOT_INSTRUCTION = [
  /\bignore\b.{0,40}\b(rules?|instructions?|prompt|guard|above|previous|truth\w*|role\.md|schema|policy|policies|limits?)\b/i,
  /\bdisregard\b/i,
  /\bsystem prompt\b/i,
  /\bprompt\b/i,
  /role\.md/i,
  /bot\.json/i,
  /\boutput schema\b/i,
  /\bself-?check\b/i,
  /\bjson\b/i,
  /\b(?:the|your)\s+(?:cv\s+)?(?:bot|writer|model|ai|assistant|llm|agent)s?\b/i,
  /\byou are (?:a|an|the) (?:bot|model|ai|assistant|cv writer)\b/i,
  // A bare role prefix ("Assistant: …", "System: …") or talk about the checks themselves.
  /(?:^|[\s"'([])(?:assistant|system|user|developer|tool|human)\s*:/i,
  /\btruth\s*check\b|\bguard\s*rails?\b|\bsafety (?:check|rule)s?\b/i,
  /\bbỏ qua\b.{0,40}\b(quy tắc|hướng dẫn|chỉ dẫn|lệnh)\b/i,
  /\b(?:lời nhắc|câu lệnh hệ thống)\b/i,
];

/** Telling the CV to make something up: always rejected. */
const INVENT_VERBS_EN = /\b(invent|fabricate|make up|made up|assume|estimate|guess|approximate|round(?:ed|ing)? up|inflate|exaggerate|embellish|pad|stretch the truth|fake)\b/i;
const INVENT_VERBS_VI = /(bịa|phóng đại|ước lượng|ước tính|làm tròn|giả định|khai khống|thổi phồng|tự thêm|tự bổ sung|nói quá|đoán)/i;

/** Telling the CV to add something: rejected when the object is a fact, number or date… */
const ADD_VERBS_EN = /\b(add|adding|include|including|insert|put|list|listing|claim|state|mention|write|show|give|quantify)\b/i;
const ADD_VERBS_VI = /(thêm|bổ sung|ghi|liệt kê|đưa vào|chèn|nêu|kể|thể hiện|trình bày|viết)/i;
/** Taking a fact from the posting (F4): mirror, match or copy the JD's technologies or title. */
const FROM_POSTING_EN = /\b(mirror|match(?:es|ing)?|copy|copies|copying|echo|replicate|reuse|repeat|use|take|align)\b.{0,60}\b(job description|jd|posting|job post|job ad|advert(?:isement)?|vacancy|listing|role description)\b/i;
const FROM_POSTING_VI = /(sao chép|chép|khớp|trùng|giống|lặp lại|lấy|dùng).{0,40}(mô tả công việc|jd|tin tuyển dụng|tin đăng|yêu cầu tuyển dụng)/i;
/** …unless it says to do so only where it is true ("where it matches your experience"). */
const WHERE_TRUE = /\b(?:where|if|when|that|which|only)\b.{0,40}\b(?:your (?:real |actual )?experience|you (?:have|did|used)|true|truthful|honest(?:ly)?|backed|apply to you)\b|(?:nếu|khi|chỉ).{0,30}(?:đúng|thật|có kinh nghiệm|đã làm)/i;
const SELF_TITLE = /\b(describe|present|introduce|call|brand|label|position|title|sell)\s+(?:yourself|you)\s+as\b|\b(?:always|just)\s+(?:say|write|claim)\s+(?:you(?:'re| are)|i am)\b|(?:tự giới thiệu|tự nhận|xưng|gọi mình) là/i;
/** …a number-like object: adding one is inventing one unless the facts have it. */
const NUMBER_OBJECT_EN = /\b((?<!phone |contact |mobile )numbers?|figures?|metrics?|percent(?:age)?s?|%|statistics?|stats|kpis?|results? figures?|amounts?)\b|%/i;
const NUMBER_OBJECT_VI = /(con số|số liệu|phần trăm|chỉ số|%)/i;
/** …or a fact-like object together with a "whether or not he has it" qualifier. */
const FACT_OBJECT_EN = /\b(skills?|technolog(?:y|ies)|tools?|keywords?|experience|titles?|employers?|companies|dates?|months?|years?|certifications?|degrees?|projects?)\b/i;
const FACT_OBJECT_VI = /(kỹ năng|công nghệ|công cụ|từ khóa|kinh nghiệm|chức danh|công ty|tháng|năm|chứng chỉ|bằng cấp|dự án)/i;
const REGARDLESS_EN = /\b(even if|even though|even without|regardless|whether or not|without (?:having|real|any|practical|actual)|you (?:do not|don't|have not|haven't|lack)|not (?:have|used|worked)|every (?:skill|keyword|technology|tool)|all (?:the )?(?:skills|keywords|technologies|tools|requirements)|each (?:skill|keyword|requirement)|if (?:missing|unknown|you are not sure)|when (?:missing|unknown|in doubt))\b/i;
const REGARDLESS_VI = /(dù (?:không|chưa)|kể cả khi|mặc dù (?:không|chưa)|chưa có kinh nghiệm|không có kinh nghiệm|tất cả (?:kỹ năng|từ khóa|công nghệ|yêu cầu)|mọi (?:kỹ năng|từ khóa|công nghệ|yêu cầu)|nếu không (?:có|nhớ|biết))/i;
/** A negation before the verb ("Do not list…", "Không liệt kê…", "Avoid adding…") makes it a prohibition. */
const NEGATION = /\b(do not|don't|never|avoid|no|not|stop|without|nor)\b|(không|đừng|tránh|chớ|hạn chế|không nên)/i;

function negatedBefore(text: string, verb: RegExp): boolean {
  const m = verb.exec(text);
  if (!m) return false;
  const before = text.slice(Math.max(0, m.index - 24), m.index);
  return NEGATION.test(before);
}

/** Why a drafted statement is refused (SEC-22), or null when it may enter the rule set. */
export function screenStatement(text: string): string | null {
  const t = text.normalize("NFC");
  if (t.trim().length === 0) return "the statement is empty";
  if (t.length > GUIDANCE_LIMITS.textChars) return `the statement has ${t.length} characters (at most ${GUIDANCE_LIMITS.textChars})`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(t)) return "the statement has control characters";
  if (/[<>]/.test(t)) return "the statement has markup";
  if (URL_IN_TEXT.test(t)) return "the statement has a URL";
  if (BOT_INSTRUCTION.some((re) => re.test(t))) return "the statement is an instruction to the bot or its configuration";
  if ((INVENT_VERBS_EN.test(t) && !negatedBefore(t, INVENT_VERBS_EN)) || (INVENT_VERBS_VI.test(t) && !negatedBefore(t, INVENT_VERBS_VI))) {
    return "the statement tells the CV to make up, assume or estimate a fact";
  }
  const addEn = ADD_VERBS_EN.test(t) && !negatedBefore(t, ADD_VERBS_EN);
  const addVi = ADD_VERBS_VI.test(t) && !negatedBefore(t, ADD_VERBS_VI);
  if ((addEn && NUMBER_OBJECT_EN.test(t)) || (addVi && NUMBER_OBJECT_VI.test(t))) {
    return "the statement tells the CV to add a number or result figure (only Ba's facts may give one)";
  }
  if ((addEn && FACT_OBJECT_EN.test(t) && REGARDLESS_EN.test(t)) || (addVi && FACT_OBJECT_VI.test(t) && REGARDLESS_VI.test(t))) {
    return "the statement tells the CV to list a fact, skill or date Ba may not have";
  }
  // F4: a specific figure ("30% growth") is a number the CV would have to state.
  if (/\d+(?:[.,]\d+)?\s*%/.test(t)) return "the statement gives a figure the CV would have to state (only Ba's facts may give one)";
  if ((FROM_POSTING_EN.test(t) || FROM_POSTING_VI.test(t)) && (FACT_OBJECT_EN.test(t) || FACT_OBJECT_VI.test(t) || /\b(stack|requirements?)\b/i.test(t)) && !WHERE_TRUE.test(t)) {
    return "the statement tells the CV to take a skill, title or requirement from the posting rather than Ba's facts";
  }
  if (SELF_TITLE.test(t) && (titlesIn(t).length > 0 || /\b(expert|guru|ninja|rockstar)\b/i.test(t))) return "the statement tells the CV to claim a title Ba's facts may not give";
  return null;
}

// ---------------------------------------------------------------- constraint mapping (SEC-22)

const MORE_THAN_ONE_PAGE = /\b(?:(?:1|one)\s*(?:-|–|to|or)\s*(?:2|two|3|three)|2|3|4|two|three|four|multiple|several|more than one|over one)\s*-?\s*pages?\b|(?:1\s*[-–]\s*)?[2-9]\s*trang|hai trang|ba trang|nhiều trang|có nhiều trang|vượt quá một trang/i;
const NOT_REAL_TEXT = /\b(photos?|pictures?|images?|graphics?|icons?|charts?|infographics?|logos?|text boxes|columns of images)\b|(ảnh|hình ảnh|biểu đồ|đồ họa|biểu tượng)/i;
const CREATIVE_HEADINGS = /\b(creative|custom|unusual|catchy|fun)\s+(section\s+)?(headings?|titles?)\b|tiêu đề (?:sáng tạo|độc đáo)/i;
const OMIT_CONTACT = /\b(omit|leave out|remove|drop|skip)\b.{0,30}\b(contact|email|phone)\b|(bỏ|lược bỏ).{0,20}(liên hệ|email|số điện thoại)/i;

/** What a position recommends that a constraint forbids (by topic and text). */
export function constraintsOverriding(topic: GuidanceTopic, text: string): CvConstraintId[] {
  const out = new Set<CvConstraintId>();
  const prohibition = (re: RegExp) => negatedBefore(text, re);
  if (topic === "length" && MORE_THAN_ONE_PAGE.test(text)) out.add("over_one_page");
  if (topic === "layout_ats" || topic === "other") {
    if (NOT_REAL_TEXT.test(text) && !prohibition(NOT_REAL_TEXT)) out.add("cv_ats_real_text");
    if (CREATIVE_HEADINGS.test(text) && !prohibition(CREATIVE_HEADINGS)) out.add("cv_ats_plain_headings");
    if (MORE_THAN_ONE_PAGE.test(text) && !prohibition(MORE_THAN_ONE_PAGE)) out.add("over_one_page");
  }
  if ((topic === "contact" || topic === "other") && OMIT_CONTACT.test(text) && !prohibition(OMIT_CONTACT)) out.add("cv_contact_line");
  return [...out].sort();
}

// ---------------------------------------------------------------- sources

/** The ICANN registrable domain of an https URL ("indeed.com", "blogspot.com"), or null. */
export function registrableHost(url: string): string | null {
  try {
    const u = new URL(url);
    // F2: ICANN registrable domains only: a.blogspot.com and b.blogspot.com are one publisher host.
    const p = parse(u.hostname, { allowPrivateDomains: false });
    return p.domain ?? null;
  } catch {
    return null;
  }
}

/** The host key of a repo-file source: one publisher, counted once. */
export const attachmentHost = (publisher: string): string => `attachment:${normaliseForMatch(publisher).replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "")}`;

const ATS_VENDORS = ["jobscan.co", "workable.com", "greenhouse.com", "greenhouse.io", "lever.co", "smartrecruiters.com", "icims.com", "teamtailor.com", "bamboohr.com", "recruitee.com", "jobvite.com", "workday.com", "ashbyhq.com", "breezy.hr", "manatal.com", "base.vn"];
const GLOBAL_RECRUITERS = ["indeed.com", "linkedin.com", "glassdoor.com", "monster.com", "ziprecruiter.com", "roberthalf.com", "hays.com", "michaelpage.com", "randstad.com", "adecco.com", "robertwalters.com", "careerbuilder.com", "seek.com.au", "totaljobs.com", "reed.co.uk", "dice.com", "wellfound.com"];

/** Kind and market of a fetched page, by code (never from model output). */
export function classifySource(host: string, pageText: string): { kind: GuidanceSourceKind; market: GuidanceMarket } {
  const vnLetters = (pageText.slice(0, 5000).match(/[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/gi) ?? []).length;
  const market: GuidanceMarket = host.endsWith(".vn") || vnLetters > 40 ? "vn" : "global";
  if (ATS_VENDORS.includes(host)) return { kind: "ats_vendor", market };
  if (market === "vn") return { kind: "vn_recruiter", market };
  if (GLOBAL_RECRUITERS.includes(host)) return { kind: "global_recruiter", market };
  return { kind: "hr_publication", market };
}

/** A slug from free text (rule and source ids). */
export function slugFrom(s: string, max = 40): string {
  const slug = s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "x";
}

// ---------------------------------------------------------------- cv.review fixes (F4)

/** A fix that removes or reorders refers to what the CV already says; any other may only use the cited facts. */
const REMOVE_OR_MOVE = /^\s*(remove|drop|delete|cut|shorten|trim|move|reorder|put|swap|merge|split|lead with|start with|bỏ|xóa|xoá|rút gọn|chuyển|đưa)\b/i;

/**
 * F4: a cv.review fix reaches tailor only if it passes the content screen and names no skill, tool,
 * figure or name the cited facts lack (a removal may name what it removes). Null when it may go.
 */
export function screenGuidanceFix(instruction: string, cited: readonly { text: string; textVi?: string | null; tags?: readonly string[]; org?: string | null }[]): string | null {
  const problem = screenStatement(instruction);
  if (problem) return problem;
  // Removing or reordering refers to what the CV already says (the pre-QA truth check still runs on the result).
  if (REMOVE_OR_MOVE.test(instruction)) return null;
  const corpus = cited.flatMap((f) => [f.text, f.textVi ?? "", ...(f.tags ?? []), f.org ?? ""]).join("\n");
  for (const term of termsIn(instruction)) if (!termIn(term, corpus)) return `the fix names ${term}, which the cited facts do not`;
  const numbers = instruction.match(/\d+(?:[.,]\d+)?/g) ?? [];
  for (const n of numbers) if (!corpus.includes(n)) return `the fix gives the figure ${n}, which the cited facts do not`;
  for (const name of capitalisedNames(instruction)) {
    if (/^(CV|JD|ATS|PDF)$/.test(name)) continue;
    if (!termIn(name, corpus)) return `the fix names ${name}, which the cited facts do not`;
  }
  return null;
}
