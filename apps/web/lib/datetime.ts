// Human times for the UI (PM S8: "Claude paused until 14:05 · resumes in 2h 10m", never raw
// seconds). Shown in the machine's time zone (Ba's Mac, Asia/Ho_Chi_Minh).

const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dayTime = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dateTime = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "45s", "13m", "2h 10m", "1d 2h". Minutes round up, so a countdown never promises too early. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** A future time: "14:05" today, "Tue 13 Oct, 09:00" otherwise. */
export function formatClock(iso: string, now: number = Date.now()): string {
  const at = new Date(iso);
  return sameDay(at, new Date(now)) ? time.format(at) : dayTime.format(at).replace(/^(\w{3}),? /, "$1 ");
}

/** A past time (messages, runs): "09:00" today, "9 Oct, 15:02" before. */
export function formatWhen(iso: string, now: number = Date.now()): string {
  const at = new Date(iso);
  return sameDay(at, new Date(now)) ? time.format(at) : dateTime.format(at);
}

/** How long a step or task took (or has run so far): "6m 35s", "4s", "—". */
export function formatElapsed(start: string | null, end: string | null, now: number = Date.now()): string {
  if (!start) return "—";
  const ms = (end ? Date.parse(end) : now) - Date.parse(start);
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return formatDuration(ms);
}
