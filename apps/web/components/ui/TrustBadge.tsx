import { cn } from "@/lib/cn";
import type { TrustLevel } from "@/lib/api/types";

// Spec §5.3 trust levels.
export const TRUST_DESCRIPTIONS: Record<TrustLevel, string> = {
  0: "L0 · draft only; every output needs your acceptance",
  1: "L1 · acts, but every outward-facing action needs your approval",
  2: "L2 · acts on its own within its allowed tools",
};

const STYLES: Record<TrustLevel, string> = {
  0: "border-border text-muted",
  1: "border-warn/40 text-warn",
  2: "border-accent/30 text-accent/80",
};

export function TrustBadge({ level, className }: { level: TrustLevel; className?: string }) {
  return (
    <span
      title={TRUST_DESCRIPTIONS[level]}
      aria-label={`Trust level L${level}`}
      data-trust={level}
      className={cn("rounded border px-1 text-[9px] leading-4 font-medium", STYLES[level], className)}
    >
      L{level}
    </span>
  );
}
