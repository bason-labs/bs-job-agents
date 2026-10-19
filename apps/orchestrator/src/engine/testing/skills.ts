// Skill self-repair: source skill files in memory, for engine tests. Same contract as SkillStore
// (adapters/skill-store): one file per source key, `failNextWrite` makes the next replace throw.
import type { SkillFiles } from "../ports.js";

export class MemorySkillFiles implements SkillFiles {
  readonly files = new Map<string, string>();
  readonly writes: { source: string; text: string }[] = [];
  /** The next write throws this message (SEC-14.AC-1). */
  failNextWrite: string | null = null;

  constructor(initial: Record<string, string> = {}) {
    for (const [source, text] of Object.entries(initial)) this.files.set(source, text);
  }

  pathOf(source: string): string {
    return `bots/research/skills/source-${source.replace(/_/g, "-")}/SKILL.md`;
  }

  read(source: string): string {
    const text = this.files.get(source);
    if (text === undefined) throw new Error(`there is no skill for ${source}`);
    return text;
  }

  write(source: string, text: string): void {
    if (this.failNextWrite !== null) {
      const message = this.failNextWrite;
      this.failNextWrite = null;
      throw new Error(message);
    }
    if (!this.files.has(source)) throw new Error(`there is no skill folder for ${source}`);
    this.files.set(source, text);
    this.writes.push({ source, text });
  }
}
