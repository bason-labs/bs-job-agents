// Salary text as the boards show it → min/max/currency (W4a, §7.5 minimum salary).
// Vietnamese formats: "15 - 25 triệu", "Tới 30 triệu", "Trên 20 triệu", "20.000.000 đ", "Thỏa thuận";
// English: "Up to $2,000", "1,000 - 3,000 USD", "From 1,200 USD". Hidden salaries ("Sign in to view
// salary") and text without numbers are null: a salary is never invented.
import type { Currency } from "@bs-job-agents/shared";
import { foldText } from "./text.js";

export interface ParsedSalary {
  min: number | null;
  max: number | null;
  currency: Currency | null;
  /** "Thỏa thuận" / "Negotiable" / "Competitive": no amount shown. */
  negotiable: boolean;
}

const NEGOTIABLE = /\b(thoa thuan|negotiable|negotiate|canh tranh|competitive|thuong luong)\b/;
const UP_TO = /\b(toi|len den|len toi|up to|upto|max|maximum|den)\b/;
const FROM = /\b(tren|tu|from|over|min|minimum|at least|above)\b/;

/** "2,000" / "20.000.000" are thousands groups; "12,5" / "2.5" are decimals. */
function toNumber(raw: string): number | null {
  const s = raw.trim();
  if (/^\d{1,3}([.,]\d{3})+$/.test(s)) return Number(s.replace(/[.,]/g, ""));
  if (/^\d+([.,]\d+)?$/.test(s)) return Number(s.replace(",", "."));
  return null;
}

export function parseSalary(text: string | null | undefined): ParsedSalary | null {
  const t = foldText(text);
  if (!t) return null;
  if (NEGOTIABLE.test(t)) return { min: null, max: null, currency: null, negotiable: true };

  // Numbers with an optional unit right after them ("20tr", "2.5k", "25 trieu", "3 m").
  const re = /(\d[\d.,]*)\s*(trieu|tr|k|m|mil|million)?(?![a-z])/g;
  const amounts: { value: number; unit: string | undefined }[] = [];
  for (const m of t.matchAll(re)) {
    const value = toNumber(m[1]!.replace(/[.,]$/, ""));
    if (value !== null) amounts.push({ value, unit: m[2] });
  }
  if (amounts.length === 0) return null;

  const usd = /\$|\busd\b|\bus dollars?\b/.test(t);
  const anyUnit = amounts.some((a) => a.unit === "trieu" || a.unit === "tr" || a.unit === "m" || a.unit === "mil" || a.unit === "million");
  const vnd = !usd && (/\bvnd\b|\bdong\b|₫|\bd\b/.test(t) || anyUnit || amounts.some((a) => a.value >= 100_000));
  const currency: Currency | null = usd ? "USD" : vnd ? "VND" : null;

  // A unit on any number applies to the whole range ("15 - 25 triệu").
  const sharedUnit = amounts.find((a) => a.unit)?.unit;
  const scale = (a: { value: number; unit: string | undefined }): number => {
    const unit = a.unit ?? sharedUnit;
    if (unit === "k") return Math.round(a.value * 1_000);
    if (unit === "trieu" || unit === "tr" || unit === "m" || unit === "mil" || unit === "million") return Math.round(a.value * 1_000_000);
    return a.value;
  };
  const values = amounts.slice(0, 2).map(scale);

  if (values.length >= 2) return { min: values[0]!, max: values[1]!, currency, negotiable: false };
  const v = values[0]!;
  if (UP_TO.test(t)) return { min: null, max: v, currency, negotiable: false };
  if (FROM.test(t)) return { min: v, max: null, currency, negotiable: false };
  return { min: v, max: v, currency, negotiable: false };
}
