// Text helpers shared by the source adapters (W4a).

/** Collapse whitespace (incl. NBSP) and trim. */
export function cleanText(s: string | null | undefined): string {
  return (s ?? "").replace(/[\s ]+/g, " ").trim();
}

/** Lowercase, without Vietnamese diacritics (đ → d) and with single spaces: for matching only. */
export function foldText(s: string | null | undefined): string {
  return cleanText(s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

/** URL slug as the boards use them: "Frontend Engineer (React)" → "frontend-engineer-react". */
export function slugify(s: string): string {
  return foldText(s)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
