// Labels and colour tones for statuses shown in StatusPill (spec §9). The status
// literals come from @bs-job-agents/shared; status.test.ts checks every shared
// application, run, step and task status has a label here.
import {
  RUN_STATUSES,
  TASK_STATUSES,
  type ApplicationStatus,
  type RunStatus,
  type TaskStatus,
} from "@bs-job-agents/shared";

export type Tone = "neutral" | "brand" | "accent" | "ok" | "warn" | "danger";

export interface StatusMeta {
  label: string;
  tone: Tone;
  /** Pulses: something is happening right now. */
  live?: boolean;
}

/** Statuses the Applications table shows and Ba sets by hand (UC-13), plus needs_check. */
export const APPLICATION_STATUSES = [
  "submitted",
  "interviewing",
  "offer",
  "rejected",
  "withdrawn",
  "no_response",
  "needs_check",
] as const satisfies readonly ApplicationStatus[];
export type { ApplicationStatus, RunStatus, TaskStatus };

export { RUN_STATUSES, TASK_STATUSES };

const META: Record<string, StatusMeta> = {
  // applications (UC-08, UC-11, UC-13)
  approved: { label: "Approved", tone: "accent" },
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
  // steps (Flow canvas nodes, §11)
  pending: { label: "Pending", tone: "neutral" },
  locked: { label: "Locked", tone: "neutral" },
  skipped: { label: "Skipped", tone: "neutral" },
};

function humanise(status: string): string {
  const s = status.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function statusMeta(status: string): StatusMeta {
  return META[status] ?? { label: humanise(status), tone: "neutral" };
}

/** True when `status` has its own label and tone (not the humanised fallback). */
export function hasStatusMeta(status: string): boolean {
  return Object.prototype.hasOwnProperty.call(META, status);
}
