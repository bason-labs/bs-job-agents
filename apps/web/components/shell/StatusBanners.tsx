"use client";

import { CircleAlert, Globe, PauseCircle } from "lucide-react";
import type { HealthState } from "@/lib/api/contract";
import type { ShellData } from "@/lib/api/types";
import { formatClock, formatDuration } from "@/lib/datetime";
import { useNow } from "@/lib/useNow";

/** "Claude paused until 14:05 · resumes in 2h 10m" (PM S8; UC-16 shows the clock time). */
export function pausedText(label: string, until: string, now: number): string {
  const left = Date.parse(until) - now;
  return `${label} paused until ${formatClock(until, now)} · ${left > 0 ? `resumes in ${formatDuration(left)}` : "resuming now"}`;
}

/** Engine paused (UC-16) / Chrome not connected (§10.3) banner under the top bar. */
export function PausedBanner({ data }: { data: ShellData }) {
  const paused = data.usage.filter((u) => u.pausedUntil);
  const now = useNow(paused.length > 0);
  if (!paused.length && data.chromeConnected) return null;
  return (
    <div
      role="status"
      data-testid="paused-banner"
      className="mx-3 mt-3 flex flex-wrap gap-x-5 gap-y-1 rounded-2xl border border-warn/40 bg-warn/10 px-4 py-2 text-xs text-warn md:mx-5"
    >
      {paused.map((u) => (
        <span key={u.engine} className="inline-flex items-center gap-1.5">
          <PauseCircle aria-hidden className="size-3.5" />
          {now === null ? `${u.label} paused` : pausedText(u.label, u.pausedUntil!, now)}
        </span>
      ))}
      {data.chromeConnected ? null : (
        <span className="inline-flex items-center gap-1.5">
          <Globe aria-hidden className="size-3.5" />
          Chrome not connected — browser steps waiting
        </span>
      )}
    </div>
  );
}

/** The shared DegradedReason values (PM S19) in plain words. */
const DEGRADED_TEXT: Record<string, string> = {
  data_dir_invalid: "The data folder can't be used",
  db_open_failed: "data/app.db couldn't be opened",
  schema_guard: "The database is missing one of its safety triggers",
  workflows_invalid: "A workflow file is invalid",
  bots_invalid: "A bot definition is invalid",
  engine_start_failed: "The engine didn't start",
};

/** What the degraded-start (PM S19) or unreachable banner says; null when healthy. */
export function healthMessage(health: HealthState): string | null {
  if (health.ok) return null;
  if (health.reason === "unreachable") {
    return "Can't reach the orchestrator. Start it with `pnpm dev:orchestrator`; this page reconnects by itself.";
  }
  if (health.reason === "prompt_version_stale") {
    // PM decision 8 copy; the orchestrator's detail names the file.
    const bot = /bots\/([a-z][a-z0-9-]*)\/ROLE\.md/.exec(health.detail ?? "")?.[1];
    if (bot) return `bots/${bot}/ROLE.md changed without a version bump. Bump promptVersion in bots/${bot}/bot.json, then restart.`;
  }
  if (health.reason === "api_error") return `The orchestrator answered in a way this screen doesn't understand${health.detail ? `: ${health.detail}` : ""}.`;
  const what = DEGRADED_TEXT[health.reason ?? ""] ?? `The orchestrator runs in degraded mode (${health.reason ?? "unknown reason"})`;
  return `${what}${health.detail ? `: ${health.detail}` : ""}. Bots won't run until this is fixed.`;
}

export function HealthBanner({ health }: { health: HealthState }) {
  const message = healthMessage(health);
  if (!message) return null;
  return (
    <div
      role="alert"
      data-testid="health-banner"
      className="mx-3 mt-3 flex items-start gap-2 rounded-2xl border border-danger/40 bg-danger/5 px-4 py-2 text-xs text-danger md:mx-5"
    >
      <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}
