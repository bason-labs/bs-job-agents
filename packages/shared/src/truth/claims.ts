// The shared truth comparison (CV auto-extend §5.2, SEC-15): which numbers, years, months,
// durations and job titles a text states, after normalising the forms people write them in
// ("six", "3+", "3yrs", "a decade", "2021-25", "Jun 2023" = "06/2023", "Present" = "hiện tại"),
// and which of them a set of source texts does not contain. Pure, no I/O: the fact-draft guard,
// the derived-fact screen and the CV guidance review (sub-project 3) all use it.

/** Number words (EN and VI) as digit strings. Not "năm": it also means "year". */
export const NUMBER_WORDS: Record<string, string> = {
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  twelve: "12", twenty: "20", hundred: "100", thousand: "1000",
  "một": "1", hai: "2", ba: "3", "bốn": "4", "sáu": "6", "bảy": "7", "tám": "8", "chín": "9", "mười": "10",
  "trăm": "100", "nghìn": "1000", "ngàn": "1000",
};

/** More number words a claim may use (the fact-draft guard keeps its own, smaller list). */
const CLAIM_NUMBER_WORDS: Record<string, string> = {
  ...NUMBER_WORDS,
  eleven: "11", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17", eighteen: "18", nineteen: "19",
  thirty: "30", forty: "40", fifty: "50", sixty: "60", seventy: "70", eighty: "80", ninety: "90", dozen: "12", million: "1000000",
  "triệu": "1000000",
};
/** Words that are numbers in a dictionary but almost never a claim: "một" is the article "a"; "Ba" is Ba. */
const NOT_A_CLAIM = new Set(["một"]);

const MONTH_NUMBERS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** Month names a text may spell out (the fact-draft guard skips them as names). */
export const MONTHS = new Set(Object.keys(MONTH_NUMBERS));

export const lower = (s: string): string => s.normalize("NFC").toLowerCase();

/** Numbers as digit strings ("1,000" and "1.000" → "1000", "40%" → "40"), digits inside words included. */
export function numbersIn(s: string): string[] {
  return [...s.matchAll(/\d+(?:[.,]\d+)*/g)].map((m) => m[0].replace(/[.,]/g, "").replace(/^0+(?=\d)/, ""));
}

/** Every number a source text gives, as digits or as a number word. */
export function allowedNumbers(corpus: string): Set<string> {
  const out = new Set(numbersIn(corpus));
  for (const word of lower(corpus).split(/[^\p{L}]+/u)) {
    const n = NUMBER_WORDS[word];
    if (n) out.add(n);
  }
  return out;
}

/**
 * Capitalised names in a text that look like tools, products or employers: a word with a capital
 * after its first letter or a digit among letters (GraphQL, AWS, K8s, EC2), or any capitalised word
 * that does not start a sentence. Only ASCII words count (Vietnamese words carry diacritics).
 */
export function capitalisedNames(text: string): string[] {
  const out: string[] = [];
  let sentenceStart = true;
  for (const m of text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}+#.\-/]*|[.!?•\n]/gu)) {
    const raw = m[0];
    if (/^[.!?•\n]$/.test(raw)) {
      sentenceStart = true;
      continue;
    }
    const word = raw.replace(/[.\-/]+$/, "");
    const atStart = sentenceStart;
    sentenceStart = raw.endsWith(".");
    if (!/^[A-Za-z0-9+#.\-/]+$/.test(word) || !/[A-Z]/.test(word)) continue;
    if (MONTHS.has(word.toLowerCase()) || word === "I") continue;
    const inner = /[A-Z]/.test(word.slice(1)) || (/\d/.test(word) && /[A-Za-z]/.test(word));
    if (inner || !atStart) out.push(word);
  }
  return out;
}

// ---------------------------------------------------------------- claims

/** What a text states that a source has to back: normalised, in text order. */
export interface Claims {
  /** Plain numbers and years ("6", "2023"), never the month of a date. */
  numbers: string[];
  /** Year-months "2023-06", or "*-06" for a month named without a year. */
  months: string[];
  /** Lengths of time: "3y", "18m", "1.5y", "since:2021", "several-y". */
  durations: string[];
  /** Job-title words, canonical English ("lead", "engineer"). */
  titles: string[];
  /** "Present" / "hiện tại" (an end date that is now). */
  present: boolean;
}

const D = String.raw`\d+(?:[.,]\d+)?`;
const EN_WORDS = Object.keys(CLAIM_NUMBER_WORDS).filter((w) => /^[a-z]+$/.test(w));
const VI_WORDS = Object.keys(CLAIM_NUMBER_WORDS).filter((w) => !/^[a-z]+$/.test(w) || w === "hai" || w === "ba");
const EN_NUM = `(?:${D}|${EN_WORDS.join("|")}|a few|few|several|many)`;
const VI_NUM = `(?:${D}|${VI_WORDS.join("|")}|năm|vài|nhiều|mấy)`;
const EN_UNIT = String.raw`(?:years?|yrs?|y|months?|mos?|mths?|weeks?|wks?|decades?|days?)`;
const VI_UNIT = "(?:năm|tháng|tuần|ngày|thập kỷ|thập niên)";
const MONTH_NAME = Object.keys(MONTH_NUMBERS).join("|");
const B = String.raw`(?<![\p{L}\p{N}])`;
const E = String.raw`(?![\p{L}\p{N}])`;

function numberValue(token: string): number | "vague" | null {
  const t = token.trim();
  if (/^\d/.test(t)) return Number(t.replace(",", "."));
  if (["a few", "few", "several", "many", "vài", "nhiều", "mấy"].includes(t)) return "vague";
  if (t === "năm") return 5;
  const n = CLAIM_NUMBER_WORDS[t];
  return n === undefined ? null : Number(n);
}

function unitKey(unit: string): { key: "y" | "m" | "w" | "d"; factor: number } {
  const u = unit.trim();
  if (/^(decades?|thập kỷ|thập niên)$/.test(u)) return { key: "y", factor: 10 };
  if (/^(years?|yrs?|y|năm)$/.test(u)) return { key: "y", factor: 1 };
  if (/^(months?|mos?|mths?|tháng)$/.test(u)) return { key: "m", factor: 1 };
  if (/^(weeks?|wks?|tuần)$/.test(u)) return { key: "w", factor: 1 };
  return { key: "d", factor: 1 };
}

const durationKey = (value: number | "vague", unit: string, half = false): string => {
  const { key, factor } = unitKey(unit);
  if (value === "vague") return `several-${key}`;
  const n = (value + (half ? 0.5 : 0)) * factor;
  return `${Number.isInteger(n) ? n : n.toFixed(1).replace(/\.0$/, "")}${key}`;
};

const ym = (year: string, month: number): string => `${year}-${String(month).padStart(2, "0")}`;

interface Span {
  start: number;
  end: number;
}

/** Find matches of `re` in `s` outside `taken`, mark them taken, and hand each to `on`. */
function scan(s: string, re: RegExp, taken: Span[], on: (m: RegExpExecArray) => void): void {
  for (const m of s.matchAll(re)) {
    const start = m.index;
    const end = start + m[0].length;
    if (taken.some((t) => start < t.end && end > t.start)) continue;
    taken.push({ start, end });
    on(m as RegExpExecArray);
  }
}

/** The month (and year) of a date expression starting with "since"/"từ": "since:2023-06", "since:2021". */
function sinceKey(rest: string): string | null {
  const month = monthTokens(rest)[0];
  if (month && !month.startsWith("*")) return `since:${month}`;
  const year = /\d{4}/.exec(rest);
  return year ? `since:${year[0]}` : null;
}

function monthTokens(s: string): string[] {
  return claimsIn(s).months;
}

/** Everything `text` claims (numbers, months, durations, titles, present), normalised. */
export function claimsIn(text: string): Claims {
  // NFKC: fullwidth digits ("１０") and other compatibility forms read as the plain ones.
  const orig = text.normalize("NFKC");
  const s = orig.toLowerCase();
  const taken: Span[] = [];
  const out: Claims = { numbers: [], months: [], durations: [], titles: titlesIn(text), present: false };
  const located: { at: number; kind: keyof Omit<Claims, "titles" | "present">; value: string }[] = [];
  const put = (at: number, kind: "numbers" | "months" | "durations", value: string) => located.push({ at, kind, value });

  // 1. durations: "since 2021", "3+ years", "a decade", "half a year", "ba năm", "từ năm 2021".
  scan(s, new RegExp(`${B}(?:since|từ năm|từ tháng|từ)\\s+((?:${MONTH_NAME})\\.?\\s*,?\\s*\\d{4}|\\d{1,2}\\s*[/.-]\\s*\\d{4}|\\d{4}(?:\\s*[/.-]\\s*0[1-9])?|t\\d{1,2}\\s*/\\s*\\d{4}|\\d{1,2}\\s*(?:/|năm)\\s*\\d{4})${E}`, "gu"), taken, (m) => {
    const key = sinceKey(m[1]!);
    if (key) put(m.index, "durations", key);
  });
  scan(s, new RegExp(`${B}half\\s+(?:a|an)\\s+(year|decade)${E}`, "gu"), taken, (m) => put(m.index, "durations", m[1] === "year" ? "6m" : "5y"));
  scan(s, new RegExp(`${B}nửa\\s+(năm|thập kỷ)${E}`, "gu"), taken, (m) => put(m.index, "durations", m[1] === "năm" ? "6m" : "5y"));
  scan(s, new RegExp(`${B}(a|an|one|${EN_NUM})\\s*\\+?\\s*-?\\s*(${EN_UNIT})(\\s+and\\s+a\\s+half)?${E}`, "gu"), taken, (m) => {
    const v = m[1] === "a" || m[1] === "an" ? 1 : numberValue(m[1]!);
    if (v !== null) put(m.index, "durations", durationKey(v, m[2]!, !!m[3]));
  });
  // VI: "3 năm", "ba năm", "năm năm" (five years); never "năm 2021" (the year 2021).
  scan(s, new RegExp(`${B}(${VI_NUM})\\s*\\+?\\s*(${VI_UNIT})(?!\\s*\\d)${E}`, "gu"), taken, (m) => {
    const v = numberValue(m[1]!);
    if (v !== null) put(m.index, "durations", durationKey(v, m[2]!));
  });
  scan(s, new RegExp(`${B}(?:một\\s+)?(thập kỷ|thập niên)${E}`, "gu"), taken, (m) => put(m.index, "durations", "10y"));

  // 2. present
  scan(s, new RegExp(`${B}(present|hiện tại|hiện nay)${E}`, "gu"), taken, () => {
    out.present = true;
  });

  // 3. year-months: "Jun 2023", "06/2023", "2023-06", "tháng 6/2023", "tháng 6 năm 2023", "T6/2023".
  scan(s, new RegExp(`${B}(${MONTH_NAME})\\.?\\s*,?\\s*(\\d{4})${E}`, "gu"), taken, (m) => {
    put(m.index, "months", ym(m[2]!, MONTH_NUMBERS[m[1]!]!));
    put(m.index, "numbers", m[2]!);
  });
  scan(s, new RegExp(`${B}(?:tháng\\s*|t)(\\d{1,2})\\s*(?:[/.-]|năm)\\s*(\\d{4})${E}`, "gu"), taken, (m) => {
    const month = Number(m[1]);
    if (month >= 1 && month <= 12) {
      put(m.index, "months", ym(m[2]!, month));
      put(m.index, "numbers", m[2]!);
    }
  });
  scan(s, new RegExp(`${B}(\\d{1,2})\\s*[/.]\\s*(\\d{4})${E}`, "gu"), taken, (m) => {
    const month = Number(m[1]);
    if (month >= 1 && month <= 12) {
      put(m.index, "months", ym(m[2]!, month));
      put(m.index, "numbers", m[2]!);
    }
  });
  scan(s, new RegExp(`${B}(\\d{4})\\s*[-/.]\\s*(0[1-9])${E}`, "gu"), taken, (m) => {
    put(m.index, "months", ym(m[1]!, Number(m[2])));
    put(m.index, "numbers", m[1]!);
  });
  // A month named without a year ("in June", "tháng 6"); not "may", which is mostly a verb.
  scan(s, new RegExp(`${B}(${MONTH_NAME.split("|").filter((n) => n !== "may").join("|")})${E}`, "gu"), taken, (m) => {
    put(m.index, "months", `*-${String(MONTH_NUMBERS[m[1]!]).padStart(2, "0")}`);
  });
  scan(s, new RegExp(`${B}tháng\\s*(\\d{1,2})${E}`, "gu"), taken, (m) => {
    const month = Number(m[1]);
    if (month >= 1 && month <= 12) put(m.index, "months", `*-${String(month).padStart(2, "0")}`);
  });

  // 4. year ranges "2021-25" (the short end year is in the same century).
  scan(s, new RegExp(`${B}(\\d{4})\\s*[-–—]\\s*(\\d{2})${E}`, "gu"), taken, (m) => {
    put(m.index, "numbers", m[1]!);
    put(m.index, "numbers", `${m[1]!.slice(0, 2)}${m[2]!}`);
  });

  // 5. numbers: digits not glued to a name (EC2, K8s, HTML5 are names), with an optional unit suffix.
  scan(s, /(?<![\p{L}\p{N}.,])\d+(?:[.,]\d+)*(?=(?:\s*[%+x×kmb])?(?![\p{L}\p{N}]))/gu, taken, (m) => {
    put(m.index, "numbers", m[0].replace(/[.,]/g, "").replace(/^0+(?=\d)/, ""));
  });
  scan(s, new RegExp(`${B}(${Object.keys(CLAIM_NUMBER_WORDS).join("|")})${E}`, "gu"), taken, (m) => {
    const word = m[1]!;
    // A capitalised Vietnamese number word is a name ("Ba", "Hai"), unless a unit follows (a duration, above).
    const vi = VI_WORDS.includes(word);
    if (!NOT_A_CLAIM.has(word) && !(vi && orig[m.index] !== s[m.index])) put(m.index, "numbers", CLAIM_NUMBER_WORDS[word]!);
  });

  located.sort((a, b) => a.at - b.at);
  for (const l of located) out[l.kind].push(l.value);
  return out;
}

/** Job-title words (a closed list, EN and VI), as canonical English words, in text order. */
const TITLES: { re: RegExp; title: string }[] = [
  { re: /(?<![\p{L}])trưởng nhóm(?![\p{L}])/gu, title: "lead" },
  { re: /(?<![\p{L}])trưởng phòng(?![\p{L}])/gu, title: "head" },
  { re: /(?<![\p{L}])kỹ sư(?![\p{L}])/gu, title: "engineer" },
  { re: /(?<![\p{L}])lập trình viên(?![\p{L}])/gu, title: "developer" },
  { re: /(?<![\p{L}])kiến trúc sư(?![\p{L}])/gu, title: "architect" },
  { re: /(?<![\p{L}])giám đốc(?![\p{L}])/gu, title: "director" },
  { re: /(?<![\p{L}])quản lý(?![\p{L}])/gu, title: "manager" },
  { re: /(?<![\p{L}])cao cấp(?![\p{L}])/gu, title: "senior" },
  { re: /(?<![\p{L}])thực tập sinh(?![\p{L}])/gu, title: "intern" },
  { re: /(?<![\p{L}])nhà sáng lập(?![\p{L}])/gu, title: "founder" },
  { re: /\b(?:tech |team )?leads?\b|\bleaders?\b/g, title: "lead" },
  { re: /\bsenior\b|\bsr\.?(?=\s)/g, title: "senior" },
  { re: /\bjunior\b|\bjr\.?(?=\s)/g, title: "junior" },
  { re: /\bprincipal\b/g, title: "principal" },
  { re: /\bheads?\b/g, title: "head" },
  { re: /\bmanagers?\b/g, title: "manager" },
  { re: /\barchitects?\b/g, title: "architect" },
  { re: /\bdirectors?\b/g, title: "director" },
  { re: /\bvp\b|\bvice president\b/g, title: "vp" },
  { re: /\bchief\b/g, title: "chief" },
  { re: /\bcto\b/g, title: "cto" },
  { re: /\bceo\b/g, title: "ceo" },
  { re: /\bcio\b/g, title: "cio" },
  { re: /\b(?:co-?)?founders?\b/g, title: "founder" },
  { re: /\bengineers?\b/g, title: "engineer" },
  { re: /\bdevelopers?\b/g, title: "developer" },
  { re: /\binterns?\b/g, title: "intern" },
];

export function titlesIn(text: string): string[] {
  const s = text.normalize("NFKC").toLowerCase();
  const found: { at: number; title: string }[] = [];
  for (const { re, title } of TITLES) for (const m of s.matchAll(re)) found.push({ at: m.index, title });
  found.sort((a, b) => a.at - b.at);
  return [...new Set(found.map((f) => f.title))];
}

// ---------------------------------------------------------------- comparison

/** What a claim is compared with: the cited facts' texts (text, textVi, tags, title) and their dates. */
export interface ClaimSource {
  texts: readonly string[];
  /** Dates fields: their numbers, months and Present count; they are never a duration. */
  dates?: readonly string[];
}

export type ClaimKind = "number" | "month" | "duration" | "title" | "present";
export interface ClaimProblem {
  kind: ClaimKind;
  value: string;
}

/**
 * The claims in `text` that `source` does not back (SEC-15, REQ-27, REQ-28): a number or year not
 * in its texts or dates; a month not in them (a month named without a year needs that month in
 * some date); a duration not stated in its texts (dates never imply one); a job title its texts do
 * not name; "Present" when no source date runs to the present. Empty = nothing invented.
 */
export function unsupportedClaims(text: string, source: ClaimSource): ClaimProblem[] {
  const texts = source.texts.join("\n");
  const all = [texts, ...(source.dates ?? [])].join("\n");
  const fromAll = claimsIn(all);
  const numbers = new Set([...fromAll.numbers, ...allowedNumbers(all)]);
  const months = new Set(fromAll.months);
  const monthNumbers = new Set(fromAll.months.map((m) => m.slice(-2)));
  const durations = new Set(claimsIn(texts).durations);
  const titles = new Set(fromAll.titles);
  const claims = claimsIn(text);
  const problems: ClaimProblem[] = [];
  const add = (kind: ClaimKind, value: string) => {
    if (!problems.some((p) => p.kind === kind && p.value === value)) problems.push({ kind, value });
  };
  for (const n of claims.numbers) if (!numbers.has(n)) add("number", n);
  for (const m of claims.months) if (m.startsWith("*") ? !monthNumbers.has(m.slice(-2)) : !months.has(m)) add("month", m);
  for (const d of claims.durations) if (!durations.has(d)) add("duration", d);
  for (const t of claims.titles) if (!titles.has(t)) add("title", t);
  if (claims.present && !fromAll.present) add("present", "present");
  return problems;
}

/** A problem as a short phrase for Ba ("says 10", "says 3 years", "names the title lead"). */
export function describeClaim(p: ClaimProblem): string {
  switch (p.kind) {
    case "number":
      return `says ${p.value}`;
    case "month":
      return p.value.startsWith("*") ? `says month ${p.value.slice(2)}` : `says ${p.value.slice(5)}/${p.value.slice(0, 4)}`;
    case "duration": {
      if (p.value.startsWith("since:")) return `says since ${p.value.slice(6)}`;
      const m = /^(several-|[\d.]+)([ymwd])$/.exec(p.value);
      const unit = { y: "years", m: "months", w: "weeks", d: "days" }[(m?.[2] ?? "y") as "y"];
      return `says ${m?.[1] === "several-" ? "several" : (m?.[1] ?? p.value)} ${unit}`;
    }
    case "title":
      return `names the title ${p.value}`;
    case "present":
      return "says it runs to the present";
  }
}
