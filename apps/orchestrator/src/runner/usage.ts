// Usage-limit detection (UC-16, spike S1).
// - Claude: every run emits `rate_limit_event.rate_limit_info` with `status` and the 5-hour /
//   7-day window utilization. Statuses are "allowed", "allowed_warning" (past a warning
//   threshold) and "rejected". We pause before the wall at LIMITS.usagePauseUtilization, and on
//   any status other than the two allowed ones, or a limit error in the result.
// - Codex: `exec --json` reports no usage. A limit arrives as `error` / `turn.failed`, either as
//   the CLI's "You've hit your usage limit … try again at 3:45 PM." text or as the API body
//   (`usage_limit_reached`, `resets_at`). Neither was observed live; the parser accepts both.
import { LIMITS, type EngineUsage } from "@bs-job-agents/shared";

export interface ClaudeRateLimitWindow {
  utilization?: number | null;
  resetsAt?: number | null;
}

export interface ClaudeRateLimitInfo {
  status?: string;
  /** Epoch seconds. */
  resetsAt?: number | null;
  rateLimitType?: string;
  unifiedWindows?: Record<string, ClaudeRateLimitWindow | undefined>;
}

export interface UsageReading {
  usage: EngineUsage;
  /** True when the engine should pause (UC-16). */
  limited: boolean;
  /** Why it is limited: the CLI said so (status), or a window is at the pause threshold. */
  reason: "status" | "utilization" | null;
}

const ALLOWED_STATUSES = new Set(["allowed", "allowed_warning"]);

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const epochToIso = (sec: number | null): string | null => (sec === null ? null : new Date(sec * 1000).toISOString());
const clamp01 = (u: unknown): number | null => (isNum(u) ? Math.min(1, Math.max(0, u)) : null);

/** EngineUsage for the sidebar meter, and whether to pause. When limited, resetsAt is when every full window resets. */
export function readClaudeRateLimit(info: ClaudeRateLimitInfo, threshold: number = LIMITS.usagePauseUtilization): UsageReading {
  const five = info.unifiedWindows?.five_hour;
  const seven = info.unifiedWindows?.seven_day;
  const fiveHour = clamp01(five?.utilization);
  const sevenDay = clamp01(seven?.utilization);
  const statusLimited = typeof info.status === "string" && !ALLOWED_STATUSES.has(info.status);
  const full = [
    { u: fiveHour, w: five },
    { u: sevenDay, w: seven },
  ].filter((x) => x.u !== null && x.u >= threshold);
  const limited = statusLimited || full.length > 0;
  const top = isNum(info.resetsAt) ? info.resetsAt : null;
  let resetsAt = top;
  if (limited) {
    const candidates = full.map((x) => x.w?.resetsAt).filter(isNum);
    if (statusLimited && top !== null) candidates.push(top);
    if (candidates.length > 0) resetsAt = Math.max(...candidates);
  }
  const reason = statusLimited ? "status" : limited ? "utilization" : null;
  return { usage: { fiveHour, sevenDay, resetsAt: epochToIso(resetsAt) }, limited, reason };
}

const CLAUDE_LIMIT_TEXT = /hit your (?:[a-z-]+ )?limit|usage limit reached|usage_limit_reached|spend limit reached/i;

/** A Claude result or API-error text that reports a subscription limit. */
export function isClaudeLimitMessage(text: string): boolean {
  return CLAUDE_LIMIT_TEXT.test(text);
}

export interface CodexLimit {
  limited: boolean;
  /** null = unknown; the engine retries every LIMITS.usageRetryMs (UC-16). */
  resetsAt: string | null;
}

const CODEX_LIMIT_TEXT = /usage[_ ]limit|hit your usage limit|credits_depleted|out of credits/i;

/** Detect a Codex usage limit in an `error` / `turn.failed` message and read its reset time. */
export function detectCodexUsageLimit(message: string, now: Date): CodexLimit {
  const body = parseJson(message);
  const err = body && typeof body === "object" ? (body as { error?: Record<string, unknown> }).error : undefined;
  if (err && (err.type === "usage_limit_reached" || err.code === "usage_limit_reached")) {
    if (isNum(err.resets_at)) return { limited: true, resetsAt: epochToIso(err.resets_at) };
    if (isNum(err.resets_in_seconds)) return { limited: true, resetsAt: new Date(now.getTime() + err.resets_in_seconds * 1000).toISOString() };
    return { limited: true, resetsAt: null };
  }
  if (!CODEX_LIMIT_TEXT.test(message)) return { limited: false, resetsAt: null };
  return { limited: true, resetsAt: parseTryAgainAt(message, now) ?? parseTryAgainIn(message, now) };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "try again at 3:45 PM", "Try again at 17:05", "try again at 13 Oct 2026 9:30 AM", "… at Oct 13th, 2026 9:30 AM" (local time). */
export function parseTryAgainAt(text: string, now: Date): string | null {
  const m = /try again at\s+(.{0,40}?)(\d{1,2}):(\d{2})\s*([ap])?\.?\s*m?\.?/i.exec(text);
  if (!m) return null;
  const [, datePart = "", hh = "0", mm = "0", ampm] = m;
  let hour = Number(hh);
  if (ampm) {
    const pm = ampm.toLowerCase() === "p";
    if (hour === 12) hour = pm ? 12 : 0;
    else if (pm) hour += 12;
  }
  const minute = Number(mm);
  if (hour > 23 || minute > 59) return null;
  const date = parseDatePart(datePart);
  if (date) return new Date(date.year, date.month, date.day, hour, minute, 0, 0).toISOString();
  const at = new Date(now.getTime());
  at.setHours(hour, minute, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at.toISOString();
}

function parseDatePart(text: string): { year: number; month: number; day: number } | null {
  const dayFirst = /(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?,?\s+(\d{4})/i.exec(text);
  const monthFirst = /([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i.exec(text);
  const parts = dayFirst
    ? { day: dayFirst[1], mon: dayFirst[2], year: dayFirst[3] }
    : monthFirst
      ? { day: monthFirst[2], mon: monthFirst[1], year: monthFirst[3] }
      : null;
  if (!parts) return null;
  const month = MONTHS.indexOf(String(parts.mon).slice(0, 3).toLowerCase());
  if (month < 0) return null;
  return { year: Number(parts.year), month, day: Number(parts.day) };
}

const UNIT_MS: Array<[RegExp, number]> = [
  [/^(?:ms|milliseconds?)$/i, 1],
  [/^(?:s|secs?|seconds?)$/i, 1000],
  [/^(?:m|mins?|minutes?)$/i, 60_000],
  [/^(?:h|hrs?|hours?)$/i, 3_600_000],
  [/^(?:d|days?)$/i, 86_400_000],
];

/** "try again in 2 hours 3 minutes", "try again in 90s". */
export function parseTryAgainIn(text: string, now: Date): string | null {
  const m = /try again in\s+([^.;]+)/i.exec(text);
  if (!m) return null;
  let total = 0;
  for (const part of String(m[1]).matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) {
    const unit = UNIT_MS.find(([re]) => re.test(String(part[2])));
    if (unit) total += Number(part[1]) * unit[1];
  }
  return total > 0 ? new Date(now.getTime() + total).toISOString() : null;
}
