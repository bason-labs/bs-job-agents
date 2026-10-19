// Skill self-repair (sub-project 4 §5.3, SEC-9): the deterministic screen every drafted source skill
// passes before its validation scan. Pure, no I/O. The same function runs in CI over every committed
// skill (apps/orchestrator/src/adapters/skills.test.ts), so the runtime screen and the repo tests are
// one rule set. A draft is rejected, with the rule and a plain reason, when it:
//   - is over 20 KiB, has hidden characters, or lacks the front matter `name: source-<dir>` + `description:`
//   - drops "Read-only" or the backticked `Layout changed: …` / `No results: …` notes the checker reads
//   - changes the skill's section structure (its `## ` headings), adds raw HTML or prompt markers
//   - names a URL or host outside the source's registered hosts (SEC-9.AC-1)
//   - names a tool outside the research bot's grant, or tells the bot to log in, click apply, save,
//     follow, message, submit, fill a form, solve a CAPTCHA, open any other link, send page data
//     anywhere, or ignore, replace or skip its role, rules or output schema (SEC-9.AC-2)
//   - holds a secret-like value
//   - raises a limit above the code's (job limit, page views, the random pause between pages)
// Quoted page labels ("Ứng tuyển", `Easy Apply`) are names of things on the page, not instructions;
// a sentence that forbids an action ("Never click …") is the skill's own read-only rule.
import { SECRET_PATTERNS, hasOpaqueToken, hostWithin, hostsInText } from "../common/text-hygiene.js";

/** The largest skill the screen accepts (SEC-9). */
export const SKILL_MAX_BYTES = 20 * 1024;

export type SkillScreenRule =
  | "size"
  | "hidden_characters"
  | "front_matter"
  | "read_only"
  | "required_notes"
  | "structure"
  | "markup"
  | "off_host"
  | "tool"
  | "action"
  | "override"
  | "secret"
  | "limit";

export interface SkillScreenContext {
  /** The skill's folder name after `source-` (topcv, career-site). */
  dir: string;
  /** Registrable hosts the skill may name (subdomains match): the source's and its access record's. */
  hosts: readonly string[];
  /** Tool names as the bot sees them: the ones its grant gives (Read, navigate, …) and every other one it could name. */
  tools: { granted: readonly string[]; known: readonly string[] };
  /** The skill in force: the draft keeps its `## ` headings. Null: no structure check (a new skill). */
  current: string | null;
  /** The orchestrator's limits for this source. */
  limits: {
    /** Postings per scan (30). */
    jobLimit: number;
    /** × criteria.maxJobs (3). */
    jobLimitPerMaxJob: number;
    /** Page views per scan, or null when the code sets none. */
    maxPageViews: number | null;
    /** The random pause between page loads in seconds, or null when none is required. */
    delaySec: { min: number; max: number } | null;
  };
  /** The checker's readers of the two self-check notes (adapters/checker.ts). */
  notes: { layoutChanged(note: string): boolean; noResults(note: string): boolean };
}

export type SkillScreenResult = { ok: true } | { ok: false; rule: SkillScreenRule; reason: string };

const reject = (rule: SkillScreenRule, reason: string): SkillScreenResult => ({ ok: false, rule, reason });

// Zero-width, bidi-control and other invisible characters that could hide text from Ba's review.
// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused here
const HIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb]/;

/** `## ` headings, compared without case, numbering and extra spaces. */
export function skillHeadings(md: string): string[] {
  return [...md.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1]!.replace(/^\d+\.\s*/, "").replace(/\s+/g, " ").trim().toLowerCase());
}

/** The text with quoted labels and inline code taken out (they name page parts, they instruct nothing). */
function withoutQuotes(text: string): string {
  return text
    .replace(/`[^`\n]*`/g, " ")
    .replace(/"[^"\n]*"/g, " ")
    .replace(/“[^”\n]*”/g, " ")
    .replace(/'[^'\n]{2,60}'/g, " ");
}

/**
 * CSS selector hints (`a.company`, `ul.jobs-search__results-list`, `h3.title`) read like host names
 * whose last label is a TLD; a tag name before the dot makes them selectors. URLs are kept.
 */
const SELECTOR = /(?<![\w./:-])(?:a|abbr|article|aside|b|body|button|dd|div|dl|dt|em|footer|form|h[1-6]|header|i|img|input|label|li|main|nav|ol|p|section|small|span|strong|table|tbody|td|th|time|tr|ul)(?:\.[a-z_][\w-]*)+/gi;
const withoutSelectors = (text: string): string => text.replace(SELECTOR, " ");

/** Sentences and clauses: an action is judged within its own clause. */
function clauses(text: string): string[] {
  return text
    .split(/\n+|[.!?;](?=\s|$)|\s[—–]\s|→|\bbut\b|\bthen\b|\bafterwards\b|\balso\b/i)
    .map((c) => c.replace(/^[\s>*_#|-]+|[\s*_|]+$/g, "").replace(/^\d+\.\s+/, "").trim())
    .filter(Boolean);
}

const NEGATION = /\b(?:never|not|no|don'?t|do not|does not|doesn'?t|without|nor|avoid|stop|instead of|rather than|refuse|forbidden|must not|is not|isn'?t)\b/i;

interface ActionRule {
  pattern: RegExp;
  what: string;
  /** Judged with the quoted labels kept ('click "Ứng tuyển"'); the others without them. */
  raw?: boolean;
}

/** Things a read-only skill never tells the bot to do (SEC-9.AC-2), unless the clause forbids them. */
const ACTIONS: readonly ActionRule[] = [
  { pattern: /(?<!\b(?:asks?|prompts?|wants?|requires?|needs?|tells you|forces you|asked)\s+(?:you\s+)?to\s+)\b(?:log|sign)\s(?:in|on)\b(?!\s*(?:wall|popup|pop-up|page|prompt|screen|form|link|button))|\blogin\s+(?:with|using|as|to)\b/i, what: "log in" },
  { pattern: /\b(?:click|press|tap|hit|select|choose|use)\b[^.;]{0,40}(?:\b(?:apply|submit|save|follow|connect|message|bid|proposal|buy|purchase|sign ?up|register)|ứng tuyển|lưu tin)/i, what: "click apply, save, follow, message or submit", raw: true },
  { pattern: /^(?:please\s+)?(?:apply|submit|save|follow|connect|message|bid|buy|purchase|register|sign ?up)\b/i, what: "apply, save, follow, message or submit" },
  { pattern: /\b(?:apply|submit|send)\b[^.;]{0,30}\b(?:for|to)\s+(?:the|each|every|this|that|all)\s+(?:job|posting|role|position)s?\b/i, what: "apply for a job" },
  { pattern: /\bfill\b[^.;]{0,30}\b(?:in|out|form|forms|field|fields)\b/i, what: "fill in a form" },
  { pattern: /\b(?:type|enter|paste)\s+(?:in\s+|into\s+)?(?:the\s+|a\s+|an\s+|ba'?s\s+|his\s+|your\s+)?(?:password|e-?mail|name|phone|details|credentials|code|text|message|form|field)/i, what: "fill in a form" },
  { pattern: /\b(?:solve|bypass|get past|pass|complete|answer)\b[^.;]{0,30}\b(?:captcha|challenge|verification|bot check|human check)/i, what: "solve a CAPTCHA" },
  { pattern: /\b(?:open|visit|follow|navigate to|go to|load|click)\b[^.;]{0,25}\b(?:any|every|all|other|external|outside|off-site|third-party)\b[^.;]{0,25}\b(?:links?|sites?|pages?|urls?|domains?|hosts?|websites?)\b/i, what: "open other links or sites" },
  {
    pattern: /\b(?:send|post|upload|email|e-mail|share|forward|transmit|exfiltrate|report|copy|leak|submit)\b[^.;]{0,60}\b(?:page|text|data|content|html|cookies?|tokens?|session|credentials?|screenshots?|details)\b[^.;]{0,60}\b(?:to|at|via)\b/i,
    what: "send page data somewhere",
  },
  { pattern: /\b(?:send|post|upload|email|e-mail|forward|transmit)\b[^.;]{0,40}\bto\s+(?:https?:|www\.|[\w.-]+@)/i, what: "send something to an address" },
  { pattern: /\b(?:run|execute|eval)\b[^.;]{0,30}\b(?:javascript|script|code|command|shell)\b/i, what: "run code" },
  { pattern: /\b(?:accept|allow|grant)\b[^.;]{0,30}\b(?:cookies?|permissions?|notifications?|prompts?|invitations?|connections?)\b/i, what: "accept a prompt" },
  { pattern: /\b(?:spend|buy|purchase)\b[^.;]{0,30}\b(?:connects?|credits?|tokens?|money)\b/i, what: "spend money" },
];

/** Text that addresses the model's rules rather than the page (SEC-9.AC-2). */
const OVERRIDES: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override|bypass|circumvent|replace|skip|drop|discard|relax|suspend|disable)\b[^.;\n]{0,40}\b(?:ROLE\.md|role|rules?|instructions?|prompts?|output schema|schemas?|self-?checks?|guards?|allow-?lists?|polic(?:y|ies)|restrictions?|limits?|safety|boundar(?:y|ies))\b/i,
  /\b(?:system prompt|new instructions?|updated instructions?|from now on|you are now|act as|pretend to be|developer mode|jailbreak|do anything now|instead of your role)\b/i,
  /\bUNTRUSTED_CONTENT\b|<<<|>>>/,
  /<\/?\s*(?:system|assistant|user|instructions?|untrusted[_ ]?content)\s*>/i,
  /(?:^|\n)\s*(?:system|assistant|developer|user)\s*:/i,
  /\bapproval ?token\b/i,
  /\b(?:output|return|report|answer)\b[^.;\n]{0,30}\b(?:passed|validated|success)\b[^.;\n]{0,30}\b(?:whatever|regardless|always|anyway)\b/i,
];

/** Numbers next to the words a limit is stated in. */
function numbersBefore(text: string, word: RegExp): number[] {
  const out: number[] = [];
  const re = new RegExp(`(\\d+)\\s*(?:${word.source})`, "gi");
  for (const m of text.matchAll(re)) out.push(Number(m[1]));
  return out;
}

function screenLimits(text: string, ctx: SkillScreenContext): SkillScreenResult {
  const { limits } = ctx;
  for (const m of text.matchAll(/(\d+)\s*[×x*]\s*`?criteria\.maxJobs/gi)) {
    if (Number(m[1]) > limits.jobLimitPerMaxJob) return reject("limit", `it raises the job limit to ${m[1]} × criteria.maxJobs (the code allows ${limits.jobLimitPerMaxJob} ×)`);
  }
  // A clause about the job limit: every "at most N" in it that is not about pages, searches or time.
  for (const clause of clauses(text)) {
    if (!/job limit|postings|candidates|\bjobs\b/i.test(clause)) continue;
    for (const m of clause.matchAll(/\b(?:never more than|no more than|at most|up to|maximum of|max\.?)\s+(\d+)(?!\s*(?:×|x\b|\*|result|search|page|view|s\b|sec|second|minute))/gi)) {
      const n = Number(m[1]);
      if (n > limits.jobLimit) return reject("limit", `it raises the job limit to ${n} postings (the code allows ${limits.jobLimit})`);
    }
  }
  if (limits.maxPageViews !== null) {
    const views = numbersBefore(text, /page[- ]views?/);
    if (views.length === 0) return reject("limit", `it drops the limit of ${limits.maxPageViews} page views per scan`);
    const over = views.find((n) => n > limits.maxPageViews!);
    if (over !== undefined) return reject("limit", `it allows ${over} page views (the code allows ${limits.maxPageViews})`);
  }
  if (limits.delaySec !== null) {
    const ranges = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(?:–|-|to)\s*(\d+(?:\.\d+)?)\s*(?:s\b|sec|seconds)/gi)].map((m) => ({ lo: Number(m[1]), hi: Number(m[2]) }));
    if (ranges.length === 0) return reject("limit", `it drops the random ${limits.delaySec.min}–${limits.delaySec.max} s pause between pages`);
    const bad = ranges.find((r) => r.lo < limits.delaySec!.min || r.hi > limits.delaySec!.max || r.lo > r.hi);
    if (bad) return reject("limit", `it changes the pause between pages to ${bad.lo}–${bad.hi} s (the code needs ${limits.delaySec.min}–${limits.delaySec.max} s)`);
    const under = [...text.matchAll(/\b(?:under|below|less than|shorter than)\s+(\d+)\s*s\b/gi)].find((m) => Number(m[1]) < limits.delaySec!.min && !NEGATION.test(text.slice(Math.max(0, m.index - 40), m.index)));
    if (under) return reject("limit", `it allows a pause under ${under[1]} s`);
  }
  return { ok: true };
}

/** Tool names the text mentions that the bot's grant does not give. */
function foreignTools(text: string, ctx: SkillScreenContext): string[] {
  const granted = new Set(ctx.tools.granted.map((t) => t.toLowerCase()));
  const out = new Set<string>();
  for (const m of text.matchAll(/\bmcp__[A-Za-z0-9_-]+/g)) out.add(m[0]);
  for (const tool of ctx.tools.known) {
    if (granted.has(tool.toLowerCase())) continue;
    const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Identifiers with an underscore (form_input) count anywhere; a plain word (computer, Bash)
    // only as code or followed by "tool".
    const re = tool.includes("_") ? new RegExp(`\\b${escaped}\\b`, "i") : new RegExp(`\`${escaped}\`|\\b${escaped}\\s+tool\\b`, "i");
    if (re.test(text)) out.add(tool);
  }
  return [...out];
}

export function screenSkillDraft(draft: string, ctx: SkillScreenContext): SkillScreenResult {
  const bytes = new TextEncoder().encode(draft).length;
  if (bytes > SKILL_MAX_BYTES) return reject("size", `it is ${Math.ceil(bytes / 1024)} KiB, over the ${SKILL_MAX_BYTES / 1024} KiB limit`);
  if (HIDDEN.test(draft)) return reject("hidden_characters", "it holds invisible or control characters");
  const md = draft.replace(/\r\n?/g, "\n");
  const front = new RegExp(`^---\\nname: source-${ctx.dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\ndescription: .+\\n---\\n`);
  if (!front.test(md)) return reject("front_matter", `it lacks the front matter with name: source-${ctx.dir} and a description`);
  if (!/Read-only/.test(md)) return reject("read_only", 'it no longer says "Read-only"');
  const layout = /`(Layout changed: [^`]+)`/.exec(md)?.[1];
  const empty = /`(No results: [^`]+)`/.exec(md)?.[1];
  if (!layout || !ctx.notes.layoutChanged(layout)) return reject("required_notes", "it drops the `Layout changed: …` note the checker reads");
  if (!empty || !ctx.notes.noResults(empty)) return reject("required_notes", "it drops the `No results: …` note the checker reads");
  if (ctx.current !== null) {
    const want = skillHeadings(ctx.current);
    const got = skillHeadings(md);
    if (JSON.stringify(want) !== JSON.stringify(got)) return reject("structure", `its sections changed (${got.join(", ") || "none"}; the skill has ${want.join(", ")})`);
  }
  if ((md.match(/^# /gm) ?? []).length !== 1) return reject("structure", "it must have exactly one title line");
  const body = md.replace(/`[^`\n]*`/g, " ");
  if (/<\s*\/?\s*[a-z][a-z0-9-]*[\s>/]/i.test(body) || /```/.test(md)) return reject("markup", "it holds raw HTML or a code block");

  const outside = hostsInText(withoutSelectors(md)).filter((h) => !hostWithin(h, ctx.hosts));
  if (outside.length > 0) return reject("off_host", `it names ${outside.join(", ")}, outside the source's hosts (${ctx.hosts.join(", ") || "none"})`);
  const tools = foreignTools(md, ctx);
  if (tools.length > 0) return reject("tool", `it names ${tools.join(", ")}, outside the research bot's tools`);
  const override = OVERRIDES.find((p) => p.test(md));
  if (override) return reject("override", "it tells the bot to set aside its role, rules or output schema");
  if (SECRET_PATTERNS.some((p) => p.test(md)) || hasOpaqueToken(md)) return reject("secret", "it holds a value that looks like a key, token, password or cookie");

  const split = { raw: clauses(md), plain: clauses(withoutQuotes(md)) };
  for (const rule of ACTIONS) {
    for (const clause of rule.raw ? split.raw : split.plain) {
      const m = rule.pattern.exec(clause);
      if (!m) continue;
      if (NEGATION.test(clause.slice(0, m.index + m[0].length))) continue;
      return reject("action", `it tells the bot to ${rule.what} ("${clause.slice(0, 120)}")`);
    }
  }
  return screenLimits(md, ctx);
}
