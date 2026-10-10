import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface FieldProps {
  label: ReactNode;
  /** id of the control, so clicking the label focuses it. */
  htmlFor?: string;
  /** id for the label element, for controls that use aria-labelledby (Select). */
  labelId?: string;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Label + control + hint/error, in the prototype's small muted label style. */
export function Field({ label, htmlFor, labelId, hint, error, children, className }: FieldProps) {
  return (
    <div className={cn("space-y-1", className)}>
      <label id={labelId} htmlFor={htmlFor} className="block text-xs text-muted">
        {label}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}
