// Labels and colour tones for statuses shown in StatusPill (spec §9).

export type Tone = "neutral" | "brand" | "accent" | "ok" | "warn" | "danger";

export interface StatusMeta {
  label: string;
  tone: Tone;
  /** Pulses: something is happening right now. */
  live?: boolean;
}

export const APPLICATION_STATUSES = [
  "submitted",
  "interviewing",
  "offer",
  "rejected",
  "withdrawn",
  "no_response",
  "needs_check",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const TASK_STATUSES = ["queued", "running", "waiting_limit", "paused", "done", "failed", "interrupted"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const RUN_STATUSES = ["running", "waiting", "paused", "done", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

const META: Record<string, StatusMeta> = {
  // applications (UC-13)
  submitted: { label: "Submitted", tone: "brand" },
  interviewing: { label: "Interviewing", tone: "accent" },
  offer: { label: "Offer", tone: "ok" },
  rejected: { label: "Rejected", tone: "danger" },
  withdrawn: { label: "Withdrawn", tone: "neutral" },
  no_response: { label: "No response", tone: "neutral" },
  needs_check: { label: "Needs check", tone: "warn" },
  // tasks
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "accent", live: true },
  waiting_limit: { label: "Waiting for limit", tone: "warn" },
  paused: { label: "Paused", tone: "warn" },
  done: { label: "Done", tone: "ok" },
  failed: { label: "Failed", tone: "danger" },
  interrupted: { label: "Interrupted", tone: "warn" },
  // runs
  waiting: { label: "Waiting", tone: "warn" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

function humanise(status: string): string {
  const s = status.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function statusMeta(status: string): StatusMeta {
  return META[status] ?? { label: humanise(status), tone: "neutral" };
}
