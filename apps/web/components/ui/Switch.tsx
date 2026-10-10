"use client";

import * as RadixSwitch from "@radix-ui/react-switch";
import { useId, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  id?: string;
  size?: "sm" | "md";
  className?: string;
  "aria-label"?: string;
}

/** Themed toggle (Radix primitive: Space/Enter toggle, ARIA switch role). */
export function Switch({ checked, onCheckedChange, label, disabled, id, size = "md", className, "aria-label": ariaLabel }: SwitchProps) {
  const autoId = useId();
  const switchId = id ?? autoId;
  return (
    <div className={cn("flex w-fit items-center gap-2.5", className)}>
      <RadixSwitch.Root
        id={switchId}
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onCheckedChange={onCheckedChange}
        className={cn(
          "relative shrink-0 rounded-full border border-border bg-surface-3 transition",
          "data-[state=checked]:border-transparent data-[state=checked]:bg-gradient-brand data-[state=checked]:shadow-glow",
          "disabled:opacity-50",
          size === "sm" ? "h-5 w-9" : "h-6 w-11",
        )}
      >
        <RadixSwitch.Thumb
          className={cn(
            "block rounded-full bg-white shadow transition-transform",
            size === "sm"
              ? "size-4 translate-x-0.5 data-[state=checked]:translate-x-[17px]"
              : "size-5 translate-x-0.5 data-[state=checked]:translate-x-[21px]",
          )}
        />
      </RadixSwitch.Root>
      {label ? (
        <label htmlFor={switchId} className={cn("text-sm select-none", disabled && "cursor-not-allowed opacity-50")}>
          {label}
        </label>
      ) : null}
    </div>
  );
}
