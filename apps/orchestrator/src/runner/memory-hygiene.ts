// Memory-note hygiene (PM2 S14, spec §5.4, §10.2 rule 4): a note goes into every later prompt of
// its bot, so a poisoned one is a persistent injection. Before a note is appended it must be a
// short lesson: no secrets, nothing phrased as an instruction that overrides the bot's rules, and
// no host outside the bot's allowlist (Research: its job sites; Apply: the task's approved
// domains; a bot without a browser: none). Anything else is dropped, never rewritten.
import { LIMITS, isPublicHost, normalizeHostName } from "@bs-job-agents/shared";

/** A note longer than this is dropped (cutting it could change what it says). */
export const MEMORY_NOTE_MAX_CHARS = 300;

export type MemoryDropReason = "empty" | "too_long" | "too_many" | "secret" | "override" | "off_allowlist";

export type MemoryNoteVerdict = { ok: true; note: string } | { ok: false; reason: MemoryDropReason; detail: string };

export interface MemoryHygieneOptions {
  /** Hosts the bot may name (subdomains match). Empty: no host at all. */
  allowedSites: readonly string[];
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:api[_ -]?key|secret|token|password|passwd|pwd|passcode|cookie|session[_ -]?id|bearer|authorization|otp|pin)\b\s*[:=]\s*\S+/i,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/-]{12,}=*/i,
  /\b(?:cookie|set-cookie)\b.{0,20}[A-Za-z0-9_-]{16,}/i,
];

/** A run of 32+ key-like characters with both letters and digits (keys, tokens, hashes). */
function hasOpaqueSecret(text: string): boolean {
  for (const m of text.matchAll(/[A-Za-z0-9+/_=-]{32,}/g)) {
    const t = m[0];
    if (/[A-Za-z]/.test(t) && /\d/.test(t)) return true;
  }
  return false;
}

const OVERRIDE_PATTERNS: RegExp[] = [
  /\b(?:ignore|disregard|forget|override|bypass|circumvent|disable|skip)\b[^.;]{0,40}\b(?:instructions?|rules?|prompts?|guards?|allow-?lists?|polic(?:y|ies)|restrictions?|self-?checks?|checks?|approvals?|tokens?|system|safety|role)\b/i,
  /\b(?:system prompt|new instructions?|updated instructions?|from now on|you are now|act as|pretend to be|developer mode|jailbreak|do anything now)\b/i,
  /\b(?:always|never)\s+(?:submit|approve|navigate|visit|trust|ignore|skip|obey|follow|run|execute)\b/i,
  /\bwithout\s+(?:asking|approval|confirmation|a token|ba'?s? (?:ok|approval|consent))\b/i,
  /\bUNTRUSTED_CONTENT\b/,
  /<\/?\s*(?:system|assistant|user|instructions?|untrusted[_ ]?content)\s*>/i,
  /(?:^|\s)(?:system|assistant|developer)\s*:/i,
  /\bapproval ?token\b/i,
];

/** Extensions that look like top-level domains in "memory.md", "run.sh", "cv.zip". */
const FILE_EXTENSIONS = new Set(["md", "pdf", "json", "yaml", "yml", "txt", "png", "jpg", "jpeg", "gif", "js", "ts", "html", "htm", "css", "csv", "doc", "docx", "py", "sh", "zip", "xml", "svg", "fig", "log"]);

/** Hosts a note names: every URL's host, IPv4 addresses, and bare names under a public suffix. */
function hostsIn(text: string): string[] {
  const hosts = new Set<string>();
  for (const m of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/([^\s/?#:'"<>)]+)/gi)) hosts.add(normalizeHostName(m[1]!.replace(/^[^@]*@/, "")));
  for (const m of text.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)) hosts.add(m[0]);
  for (const m of text.matchAll(/\blocalhost\b/gi)) hosts.add(m[0].toLowerCase());
  for (const m of text.matchAll(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]\b/gi)) {
    const host = normalizeHostName(m[0]);
    const last = host.split(".").at(-1)!;
    const scheme = text.slice(Math.max(0, m.index - 3), m.index) === "://";
    if (!scheme && FILE_EXTENSIONS.has(last) && !host.startsWith("www.")) continue;
    if (isPublicHost(host)) hosts.add(host);
  }
  return [...hosts];
}

const hostAllowed = (host: string, sites: readonly string[]): boolean =>
  sites.some((s) => {
    const site = normalizeHostName(s);
    return site !== "" && (host === site || host.endsWith(`.${site}`));
  });

/** Whitespace and control characters collapse to one space. */
export function cleanMemoryNote(note: string): string {
  return note
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function screenMemoryNote(raw: string, opts: MemoryHygieneOptions): MemoryNoteVerdict {
  const note = cleanMemoryNote(raw);
  if (note === "") return { ok: false, reason: "empty", detail: "the note is empty" };
  if (note.length > MEMORY_NOTE_MAX_CHARS) return { ok: false, reason: "too_long", detail: `longer than ${MEMORY_NOTE_MAX_CHARS} characters` };
  if (SECRET_PATTERNS.some((p) => p.test(note)) || hasOpaqueSecret(note)) {
    return { ok: false, reason: "secret", detail: "it looks like it holds a key, token, password or cookie" };
  }
  const override = OVERRIDE_PATTERNS.find((p) => p.test(note));
  if (override) return { ok: false, reason: "override", detail: "it is phrased as an instruction that overrides the bot's rules" };
  const outside = hostsIn(note).filter((h) => !hostAllowed(h, opts.allowedSites));
  if (outside.length > 0) return { ok: false, reason: "off_allowlist", detail: `it names ${outside.join(", ")}, outside the bot's allowed sites` };
  return { ok: true, note };
}

export interface FilteredMemoryNotes {
  kept: string[];
  dropped: Array<{ note: string; reason: MemoryDropReason }>;
}

/** Screen a task's notes; at most LIMITS.memoryNotesMax (3) are kept, in order. */
export function filterMemoryNotes(notes: readonly string[], opts: MemoryHygieneOptions): FilteredMemoryNotes {
  const out: FilteredMemoryNotes = { kept: [], dropped: [] };
  for (const raw of notes) {
    const v = screenMemoryNote(raw, opts);
    if (!v.ok) {
      if (v.reason !== "empty") out.dropped.push({ note: cleanMemoryNote(raw).slice(0, MEMORY_NOTE_MAX_CHARS), reason: v.reason });
      continue;
    }
    if (out.kept.length >= LIMITS.memoryNotesMax) out.dropped.push({ note: v.note, reason: "too_many" });
    else out.kept.push(v.note);
  }
  return out;
}
