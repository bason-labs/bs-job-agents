"use client";

import * as RadixCheckbox from "@radix-ui/react-checkbox";
import { Check, Minus } from "lucide-react";
import { useId, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface CheckboxProps {
  checked: boolean | "indeterminate";
  onCheckedChange: (checked: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  id?: string;
  name?: string;
  className?: string;
  "aria-label"?: string;
}

/** Themed checkbox (Radix primitive: Space toggles, ARIA checkbox role). */
export function Checkbox({ checked, onCheckedChange, label, description, disabled, id, name, className, "aria-label": ariaLabel }: CheckboxProps) {
  const autoId = useId();
  const boxId = id ?? autoId;
  return (
    <div className={cn("flex items-start gap-2.5", className)}>
      <RadixCheckbox.Root
        id={boxId}
        name={name}
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onCheckedChange={(v) => onCheckedChange(v === true)}
        className={cn(
          "mt-0.5 grid size-[18px] shrink-0 place-items-center rounded-md border transition",
          "border-border bg-surface hover:border-accent",
          "data-[state=checked]:border-transparent data-[state=checked]:bg-gradient-brand data-[state=checked]:text-white",
          "data-[state=indeterminate]:border-transparent data-[state=indeterminate]:bg-gradient-brand data-[state=indeterminate]:text-white",
          "disabled:opacity-50",
        )}
      >
        <RadixCheckbox.Indicator>
          {checked === "indeterminate" ? <Minus aria-hidden className="size-3" strokeWidth={3} /> : <Check aria-hidden className="size-3" strokeWidth={3} />}
        </RadixCheckbox.Indicator>
      </RadixCheckbox.Root>
      {label ? (
        <label htmlFor={boxId} className={cn("text-sm select-none", disabled && "cursor-not-allowed opacity-50")}>
          <span className="text-fg">{label}</span>
          {description ? <span className="block text-xs text-muted">{description}</span> : null}
        </label>
      ) : null}
    </div>
  );
}
