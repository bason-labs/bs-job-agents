"use client";

import { forwardRef, useLayoutEffect, useRef, type ChangeEvent, type InputHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { caretAfterDigits, digitsBefore, formatThousands, parseDigits } from "@/lib/format";
import { inputClass } from "./Input";

export interface NumberInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "defaultValue" | "onChange" | "type" | "min" | "max" | "size"> {
  value: number | null;
  onValueChange: (value: number | null) => void;
  min?: number;
  max?: number;
  invalid?: boolean;
  /** Text shown inside the right edge, e.g. "VND". */
  suffix?: ReactNode;
}

/**
 * Whole-number input with thousands separators (30,000,000). A text input with
 * inputMode="numeric": numeric keyboard on phones, no browser spinners.
 * Keeps the caret next to the same digit while separators move.
 */
export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(function NumberInput(
  { value, onValueChange, min, max, invalid, suffix, className, onBlur, ...rest },
  forwardedRef,
) {
  const innerRef = useRef<HTMLInputElement | null>(null);
  const pendingCaret = useRef<number | null>(null);
  const text = formatThousands(value);

  useLayoutEffect(() => {
    const el = innerRef.current;
    if (el && pendingCaret.current !== null && document.activeElement === el) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
    }
    pendingCaret.current = null;
  });

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    const caret = e.target.selectionStart ?? raw.length;
    const digitsLeft = digitsBefore(raw, caret);
    const next = parseDigits(raw);
    pendingCaret.current = caretAfterDigits(formatThousands(next), digitsLeft);
    onValueChange(next);
  };

  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));

  return (
    <div className={cn("relative", className)}>
      <input
        {...rest}
        ref={(el) => {
          innerRef.current = el;
          if (typeof forwardedRef === "function") forwardedRef(el);
          else if (forwardedRef) forwardedRef.current = el;
        }}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        value={text}
        aria-invalid={invalid || undefined}
        onChange={handleChange}
        onBlur={(e) => {
          if (value !== null && clamp(value) !== value) onValueChange(clamp(value));
          onBlur?.(e);
        }}
        className={cn(inputClass(invalid), "tabular", suffix ? "pr-14" : undefined)}
      />
      {suffix ? (
        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted">{suffix}</span>
      ) : null}
    </div>
  );
});
