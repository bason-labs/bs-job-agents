// CV guidance text policy (§5.5, SEC-22, SEC-23): the evidence match, the content screen (EN and VI
// deny-lists, table-tested in screen.test.ts), the constraint mapping (overriddenBy, set by code)
// and how a fetched page's host, kind and market are classified. Pure.
import { parse } from "tldts";
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

/** SEC-23: the quote occurs in the page's text (after normalising whitespace and case). */
export function evidenceInText(quote: string, pageText: string): boolean {
  const q = normaliseForMatch(quote).replace(/^["']+|["'.…]+$/g, "").trim();
  return q.length >= 12 && normaliseForMatch(pageText).includes(q);
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
  /\bbỏ qua\b.{0,40}\b(quy tắc|hướng dẫn|chỉ dẫn|lệnh)\b/i,
  /\b(?:lời nhắc|câu lệnh hệ thống)\b/i,
];

/** Telling the CV to make something up: always rejected. */
const INVENT_VERBS_EN = /\b(invent|fabricate|make up|made up|assume|estimate|guess|approximate|round(?:ed|ing)? up|inflate|exaggerate|embellish|pad|stretch the truth|fake)\b/i;
const INVENT_VERBS_VI = /(bịa|phóng đại|ước lượng|ước tính|làm tròn|giả định|khai khống|thổi phồng|tự thêm|tự bổ sung|nói quá|đoán)/i;

/** Telling the CV to add something: rejected when the object is a fact, number or date… */
const ADD_VERBS_EN = /\b(add|adding|include|including|insert|put|list|listing|claim|state|mention|write|show|give|quantify)\b/i;
const ADD_VERBS_VI = /(thêm|bổ sung|ghi|liệt kê|đưa vào|chèn|nêu|kể)/i;
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

/** The registrable domain of an https URL ("indeed.com"), or null. */
export function registrableHost(url: string): string | null {
  try {
    const u = new URL(url);
    const p = parse(u.hostname, { allowPrivateDomains: true });
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
