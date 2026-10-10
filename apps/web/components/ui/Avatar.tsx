import { cn } from "@/lib/cn";
import type { BotLiveStatus } from "@/lib/api/types";
import { StatusDot } from "./StatusDot";

export interface BotAvatarProps {
  name: string;
  /** Lead gets the brand gradient, like the prototype. */
  lead?: boolean;
  size?: "sm" | "md" | "lg";
  status?: BotLiveStatus;
  className?: string;
}

const SIZES = { sm: "size-6 text-[10px]", md: "size-8 text-xs", lg: "size-10 text-sm" } as const;

export function BotAvatar({ name, lead = false, size = "sm", status, className }: BotAvatarProps) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative grid shrink-0 place-items-center rounded-full font-bold",
        SIZES[size],
        lead ? "bg-gradient-brand text-white shadow-glow" : "bg-surface-3 text-accent",
        className,
      )}
    >
      {name.charAt(0).toUpperCase()}
      {status ? <StatusDot status={status} className="absolute -right-0.5 -bottom-0.5 ring-2 ring-[var(--bg)]" /> : null}
    </span>
  );
}
