// Memory-note hygiene (PM2 S14, spec §5.4, §10.2 rule 4): a note goes into every later prompt of
// its bot, so a poisoned one is a persistent injection. Before a note is appended it must be a
// short lesson: no secrets, nothing phrased as an instruction that overrides the bot's rules, and
// no host outside the bot's allowlist (Research: its job sites; Apply: the task's approved
// domains; a bot without a browser: none). Anything else is dropped, never rewritten.
import { LIMITS, SECRET_PATTERNS, hasOpaqueSecret, hostWithin, hostsInText as hostsIn } from "@bs-job-agents/shared";

/** A note longer than this is dropped (cutting it could change what it says). */
export const MEMORY_NOTE_MAX_CHARS = 300;

export type MemoryDropReason = "empty" | "too_long" | "too_many" | "secret" | "override" | "off_allowlist";

export type MemoryNoteVerdict = { ok: true; note: string } | { ok: false; reason: MemoryDropReason; detail: string };

export interface MemoryHygieneOptions {
  /** Hosts the bot may name (subdomains match). Empty: no host at all. */
  allowedSites: readonly string[];
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

const hostAllowed = hostWithin;

/** Whitespace and control characters collapse to one space. */
export function cleanMemoryNote(note: string): string {
  return note
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed here
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
