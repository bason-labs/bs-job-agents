// Text helpers shared by the source adapters (W4a).

/** Collapse whitespace (incl. NBSP) and trim. */
export function cleanText(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
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

const VI_LETTERS = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹáàãéèíìóòõúùý]/gi;

/** "vi" when the text has a meaningful share of Vietnamese letters, else "en" (JobCandidate.language). */
export function detectLanguage(text: string): "vi" | "en" {
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  if (letters === 0) return "en";
  const vi = (text.match(VI_LETTERS) ?? []).length;
  return vi / letters > 0.03 ? "vi" : "en";
}

/** URL slug as the boards use them: "Frontend Engineer (React)" → "frontend-engineer-react". */
export function slugify(s: string): string {
  return foldText(s)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
