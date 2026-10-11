// @mentions in group rooms (UC-15). Parsing uses the shared parseMentions, so the composer,
// the highlighted text and the orchestrator agree on who was mentioned.
import { parseMentions } from "@bs-job-agents/shared";

export interface RoomMember {
  name: string;
  displayName: string;
}

export interface MentionMatch {
  /** Index of the "@". */
  start: number;
  /** What follows the "@" up to the caret. */
  query: string;
}

const WORD = /[\w-]/;

/** The "@word" the caret is in, if any. Like parseMentions, "@" must start the text or follow a non-word character. */
export function mentionQuery(text: string, caret: number): MentionMatch | null {
  let i = caret;
  while (i > 0 && WORD.test(text[i - 1]!)) i--;
  if (i === 0 || text[i - 1] !== "@") return null;
  const at = i - 1;
  if (at > 0 && /[\w@.]/.test(text[at - 1]!)) return null;
  if (caret < text.length && WORD.test(text[caret]!)) return null;
  return { start: at, query: text.slice(i, caret) };
}

export function mentionOptions<M extends RoomMember>(query: string, members: readonly M[]): M[] {
  const q = query.toLowerCase();
  return members.filter((m) => m.displayName.toLowerCase().startsWith(q) || m.name.startsWith(q));
}

/** Replaces the typed "@que" with "@Name " and puts the caret after it. */
export function applyMention(text: string, match: MentionMatch, caret: number, displayName: string): { text: string; caret: number } {
  const rest = text.slice(caret);
  const inserted = /^\s/.test(rest) ? `@${displayName}` : `@${displayName} `;
  const next = text.slice(0, match.start) + inserted + rest;
  return { text: next, caret: match.start + `@${displayName} `.length };
}

/** Bot names mentioned in `text` (members only). */
export function roomMentions(text: string, members: readonly RoomMember[]): string[] {
  return parseMentions(
    text,
    members.map((m) => m.displayName),
  ).flatMap((n) => members.find((m) => m.displayName.toLowerCase() === n || m.name === n)?.name ?? []);
}

/** Splits a message so mentions of members can be highlighted. */
export function splitMentions(text: string, members: readonly RoomMember[]): { text: string; mention: boolean }[] {
  const names = new Set(members.flatMap((m) => [m.displayName.toLowerCase(), m.name]));
  const parts: { text: string; mention: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(/(^|[^\w@.])@([A-Za-z][\w-]*)/g)) {
    if (!names.has((m[2] ?? "").toLowerCase())) continue;
    const start = (m.index ?? 0) + (m[1]?.length ?? 0);
    if (start > last) parts.push({ text: text.slice(last, start), mention: false });
    parts.push({ text: `@${m[2]}`, mention: true });
    last = start + 1 + (m[2]?.length ?? 0);
  }
  if (last < text.length) parts.push({ text: text.slice(last), mention: false });
  return parts;
}
