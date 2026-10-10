import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export function inputClass(invalid?: boolean) {
  return cn(
    "w-full rounded-xl border bg-surface px-3 py-2 text-sm text-fg placeholder:text-muted/70 outline-none transition",
    "focus:border-accent focus:shadow-[var(--ring-focus)] disabled:cursor-not-allowed disabled:opacity-50",
    invalid ? "border-danger" : "border-border hover:border-accent/60",
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

/** Text input. Never use it for numbers (NumberInput), dates or checkboxes (own components). */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ invalid, className, type = "text", ...rest }, ref) {
  return <input ref={ref} type={type} aria-invalid={invalid || undefined} className={cn(inputClass(invalid), className)} {...rest} />;
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ invalid, className, rows = 4, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      aria-invalid={invalid || undefined}
      className={cn(inputClass(invalid), "resize-y leading-relaxed", className)}
      {...rest}
    />
  );
});
