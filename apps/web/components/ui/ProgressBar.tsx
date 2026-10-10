import { cn } from "@/lib/cn";

export interface ProgressBarProps {
  /** 0..100 */
  value: number;
  tone?: "brand" | "warn" | "danger";
  size?: "xs" | "sm";
  label?: string;
  className?: string;
}

export function ProgressBar({ value, tone = "brand", size = "sm", label, className }: ProgressBarProps) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      className={cn("w-full overflow-hidden rounded-full bg-surface-3", size === "xs" ? "h-1" : "h-2", className)}
    >
      <div
        className={cn("h-full rounded-full transition-[width]", tone === "brand" ? "bg-gradient-brand" : tone === "warn" ? "bg-warn" : "bg-danger")}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export interface UsageMeterProps {
  label: string;
  /** 0..1 share of the subscription window. */
  utilization: number;
  /** Seconds until auto-resume when paused for the usage limit (UC-16). */
  resumesInSeconds?: number | null;
  className?: string;
}

function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Sidebar subscription meter: "Claude 42%" or "paused · resumes in 3m". */
export function UsageMeter({ label, utilization, resumesInSeconds, className }: UsageMeterProps) {
  const paused = resumesInSeconds != null && resumesInSeconds > 0;
  const pct = Math.round(utilization * 100);
  return (
    <div className={className} data-testid={`usage-${label.toLowerCase()}`} data-paused={paused || undefined}>
      <div className="flex justify-between text-[10px]">
        <span className="text-muted">{label}</span>
        {paused ? (
          <span className="text-warn">paused · resumes in {formatWait(resumesInSeconds)}</span>
        ) : (
          <span className="tabular text-muted">{pct}%</span>
        )}
      </div>
      <ProgressBar value={paused ? 100 : pct} tone={paused ? "warn" : "brand"} size="xs" label={`${label} usage`} />
    </div>
  );
}
