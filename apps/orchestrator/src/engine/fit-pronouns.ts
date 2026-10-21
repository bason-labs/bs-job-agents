// Live 2026-10-20: research.fit wrote "says he mostly uses ReactJs" and "He owned React/Node.js
// apps". Ba's pronouns are not recorded, so text about Ba uses the name or they/them (Research
// ROLE.md, step 7). This narrow check backs the prompt up in code: a gendered pronoun in a sentence
// that is about Ba (it names Ba or the master CV), or that opens with one (fit text is about Ba),
// fails the attempt so it is retried. Sentences about the JD or the company are left alone.

const PRONOUN = /\b(he|him|his|she|her|hers)\b/i;
const ABOUT_BA = /\b(ba|master cv|master data)\b/i;
const OPENS_WITH = /^(he|his|she|her)\b/i;

/** The sentences that refer to Ba as he or she. */
export function pronounsAboutBa(texts: readonly string[]): string[] {
  const out: string[] = [];
  for (const text of texts) {
    for (const raw of text.split(/(?<=[.!?;])\s+/)) {
      const sentence = raw.trim();
      if (!sentence || !PRONOUN.test(sentence)) continue;
      if (ABOUT_BA.test(sentence) || OPENS_WITH.test(sentence)) out.push(sentence);
    }
  }
  return out;
}
