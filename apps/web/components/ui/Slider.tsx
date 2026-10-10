"use client";

import * as RadixSlider from "@radix-ui/react-slider";
import { useId } from "react";
import { cn } from "@/lib/cn";

export interface SliderProps {
  value: number;
  onValueChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  label?: string;
  "aria-label"?: string;
  disabled?: boolean;
  formatValue?: (value: number) => string;
  className?: string;
  "data-testid"?: string;
}

/**
 * Prototype `uiSlider`: gradient fill, glowing thumb, value badge, min/max
 * labels. Pointer drag and ←/→/↑/↓/Home/End come from the Radix primitive.
 */
export function Slider({
  value,
  onValueChange,
  min,
  max,
  step = 1,
  label,
  "aria-label": ariaLabel,
  disabled,
  formatValue = String,
  className,
  "data-testid": testId,
}: SliderProps) {
  const labelId = useId();
  return (
    <div className={cn("space-y-2", className)} data-testid={testId}>
      <div className="flex items-center justify-between">
        {label ? (
          <p id={labelId} className="text-xs font-medium">
            {label}
          </p>
        ) : (
          <span />
        )}
        <span
          data-testid={testId ? `${testId}-value` : undefined}
          className="tabular rounded-full bg-gradient-brand px-2.5 py-0.5 text-xs font-semibold text-white shadow-glow"
        >
          {formatValue(value)}
        </span>
      </div>
      <RadixSlider.Root
        value={[value]}
        onValueChange={(v) => onValueChange(v[0]!)}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        className="relative mt-3 flex h-5 w-full touch-none items-center select-none data-[disabled]:opacity-50"
      >
        <RadixSlider.Track className="relative h-2 grow cursor-pointer overflow-hidden rounded-full bg-surface-3 data-[disabled]:cursor-not-allowed">
          <RadixSlider.Range className="absolute h-full rounded-full bg-gradient-brand" />
        </RadixSlider.Track>
        <RadixSlider.Thumb
          aria-label={ariaLabel ?? label}
          aria-labelledby={label && !ariaLabel ? labelId : undefined}
          className="block size-5 rounded-full border-2 border-accent bg-white shadow-glow transition-transform hover:scale-110 active:scale-110 focus-visible:ring-4 focus-visible:ring-accent/30 focus-visible:outline-none"
        />
      </RadixSlider.Root>
      <div className="tabular flex justify-between text-[10px] text-muted">
        <span>{formatValue(min)}</span>
        <span>{formatValue(max)}</span>
      </div>
    </div>
  );
}
