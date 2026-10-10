import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { statusMeta, type Tone } from "@/lib/status";

const TONES: Record<Tone, string> = {
  neutral: "border-border text-muted",
  brand: "border-brand/40 text-brand-2 dark:text-accent bg-brand/5",
  accent: "border-accent/40 text-accent bg-accent/5",
  ok: "border-ok/40 text-ok bg-ok/5",
  warn: "border-warn/40 text-warn bg-warn/10",
  danger: "border-danger/40 text-danger bg-danger/5",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  /** Solid red count badge (sidebar Review count). */
  count?: boolean;
}

export function Badge({ tone = "neutral", count = false, className, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        count
          ? "tabular rounded-full bg-danger px-1.5 text-[10px] leading-4 text-white"
          : "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-none font-medium whitespace-nowrap",
        !count && TONES[tone],
        className,
      )}
      {...rest}
    />
  );
}

/** Application / task / run status (spec §9) with a consistent label and colour. */
export function StatusPill({ status, className }: { status: string; className?: string }) {
  const meta = statusMeta(status);
  return (
    <Badge tone={meta.tone} className={className} data-status={status}>
      <span aria-hidden className={cn("size-1.5 rounded-full bg-current", meta.live && "animate-pulse")} />
      {meta.label}
    </Badge>
  );
}
