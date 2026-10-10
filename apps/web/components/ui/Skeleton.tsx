import { cn } from "@/lib/cn";

/** Shimmering placeholder block. Size it with className (h-4 w-32 …). */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      data-testid="skeleton"
      className={cn(
        "animate-shimmer rounded-lg bg-[length:200%_100%]",
        "bg-[linear-gradient(90deg,var(--surface-2)_0%,var(--surface-3)_50%,var(--surface-2)_100%)]",
        className,
      )}
    />
  );
}
