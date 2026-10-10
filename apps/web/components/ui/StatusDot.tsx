import { cn } from "@/lib/cn";
import type { BotLiveStatus } from "@/lib/api/types";

const DOT: Record<BotLiveStatus, string> = {
  idle: "bg-muted/50",
  working: "bg-accent animate-pulse-dot",
  waiting: "bg-warn",
  paused: "bg-warn",
  error: "bg-danger",
  offline: "bg-surface-3 border border-border",
};

const LABEL: Record<BotLiveStatus, string> = {
  idle: "Idle",
  working: "Working",
  waiting: "Waiting",
  paused: "Paused",
  error: "Error",
  offline: "Offline",
};

export function StatusDot({ status, className }: { status: BotLiveStatus; className?: string }) {
  return (
    <span
      role="img"
      aria-label={LABEL[status]}
      title={LABEL[status]}
      data-status={status}
      className={cn("inline-block size-2 shrink-0 rounded-full", DOT[status], className)}
    />
  );
}
