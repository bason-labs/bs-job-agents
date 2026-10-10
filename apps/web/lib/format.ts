// Number formatting for NumberInput (spec §11: thousands separators, 25,000,000).

const formatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** 30000000 → "30,000,000"; null → "". */
export function formatThousands(value: number | null): string {
  return value === null ? "" : formatter.format(value);
}

/** Keeps only the digits of `text`; returns null when there are none. */
export function parseDigits(text: string): number | null {
  const digits = text.replace(/\D/g, "");
  return digits === "" ? null : Number(digits);
}

/** How many digits sit before `caret` in `text`. */
export function digitsBefore(text: string, caret: number): number {
  return text.slice(0, caret).replace(/\D/g, "").length;
}

/** Caret position in `formatted` right after its `count`-th digit. */
export function caretAfterDigits(formatted: string, count: number): number {
  if (count <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < formatted.length; i++) {
    if (/\d/.test(formatted[i]!)) seen++;
    if (seen === count) return i + 1;
  }
  return formatted.length;
}
