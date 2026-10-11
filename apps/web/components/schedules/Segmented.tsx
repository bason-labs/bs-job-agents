"use client";

import { useRef, type KeyboardEvent } from "react";
import { cn } from "@/lib/cn";

export interface SegmentedOption<V extends string> {
  value: V;
  label: string;
}

export interface SegmentedProps<V extends string> {
  options: readonly SegmentedOption<V>[];
  value: V;
  onValueChange: (value: V) => void;
  /** grid = the schedule modal's Repeat buttons; pill = the bot card's engine switch. */
  variant?: "grid" | "pill";
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "data-testid"?: string;
}

/**
 * One-of-N choice as a radio group (prototype's Repeat buttons and engine toggle).
 * Arrow keys move and choose, like native radios; only the chosen option is in the
 * tab order. Candidate for components/ui (W3b owns it).
 */
export function Segmented<V extends string>({
  options,
  value,
  onValueChange,
  variant = "grid",
  disabled = false,
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
  "data-testid": testId,
}: SegmentedProps<V>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const current = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const last = options.length - 1;
    const next =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? i === last
          ? 0
          : i + 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? i === 0
            ? last
            : i - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : null;
    if (next === null) return;
    e.preventDefault();
    onValueChange(options[next]!.value);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      aria-disabled={disabled || undefined}
      data-testid={testId}
      className={cn(
        variant === "grid" ? "grid gap-1.5" : "inline-flex rounded-full border border-border p-0.5",
        disabled && "opacity-60",
        className,
      )}
      style={variant === "grid" ? { gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` } : undefined}
    >
      {options.map((o, i) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={i === current ? 0 : -1}
            disabled={disabled}
            onClick={() => !checked && onValueChange(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "text-sm transition",
              variant === "grid" ? "rounded-xl px-2 py-1.5" : "rounded-full px-3 py-0.5 text-xs",
              checked
                ? "bg-gradient-brand text-white shadow-glow"
                : variant === "grid"
                  ? "border border-border text-fg hover:border-accent"
                  : "text-muted hover:text-fg",
              disabled && "hover:text-muted",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
