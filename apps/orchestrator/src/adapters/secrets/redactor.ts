// AD-4: every credential value read is registered here, and every error, notice and event text on
// the board-API path passes `redact` before it is stored or shown.

/** Values shorter than this are not redacted (they would mangle ordinary text; real tokens are long). */
export const MIN_REDACTED_LENGTH = 6;
export const REDACTED = "[redacted]";

export class Redactor {
  private readonly values = new Set<string>();

  register(values: Iterable<string>): void {
    for (const v of values) if (v.length >= MIN_REDACTED_LENGTH) this.values.add(v);
  }

  redact(text: string): string {
    let out = text;
    // Longest first, so a value that contains another is replaced whole.
    for (const v of [...this.values].sort((a, b) => b.length - a.length)) out = out.split(v).join(REDACTED);
    return out;
  }
}
