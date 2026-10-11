// Posting-date text → ISO datetime (W4a, JobCandidate.postedAt).
// Relative: "2 ngày trước", "Đăng 1 tuần trước", "3 giờ trước", "Hôm qua", "Posted 10 days ago",
// "30+ days ago", "yesterday". Absolute: "2026-10-05", "05/10/2026" (dd/mm/yyyy, at midnight in
// Vietnam), or a full ISO datetime. Anything else is null: a date is never guessed.
// A board's deadline ("Hạn ứng tuyển", "Hạn nộp hồ sơ") is not a posting date; callers pass only
// the posted label.
import { foldText } from "./text.js";

const DAY = 86_400_000;
const UNIT_MS: Record<string, number> = {
  phut: 60_000,
  minute: 60_000,
  min: 60_000,
  gio: 3_600_000,
  hour: 3_600_000,
  ngay: DAY,
  day: DAY,
  tuan: 7 * DAY,
  week: 7 * DAY,
  thang: 30 * DAY,
  month: 30 * DAY,
  nam: 365 * DAY,
  year: 365 * DAY,
};
const VN_OFFSET_MS = 7 * 3_600_000;

function vnMidnight(y: number, m: number, d: number): string | null {
  const t = Date.UTC(y, m - 1, d);
  const check = new Date(t);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return new Date(t - VN_OFFSET_MS).toISOString();
}

export function parsePostedDate(text: string | null | undefined, now: Date = new Date()): string | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    const t = Date.parse(raw);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  let m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(raw);
  if (m) return vnMidnight(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(raw);
  if (m) return vnMidnight(Number(m[3]), Number(m[2]), Number(m[1]));

  const t = foldText(raw);
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  if (/\b(hom nay|today|vua xong|just now|moi dang)\b/.test(t)) return ago(0);
  if (/\b(hom qua|yesterday)\b/.test(t)) return ago(DAY);
  m = /\b(\d+|an?|mot)\+?\s*(phut|minutes?|mins?|gio|hours?|ngay|days?|tuan|weeks?|thang|months?|nam|years?)\s*(truoc|ago)\b/.exec(t);
  if (m) {
    const n = /^\d+$/.test(m[1]!) ? Number(m[1]) : 1;
    const unit = m[2]!.replace(/s$/, "");
    const ms = UNIT_MS[unit];
    return ms === undefined ? null : ago(n * ms);
  }
  return null;
}
