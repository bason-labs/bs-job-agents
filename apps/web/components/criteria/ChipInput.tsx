"use client";

import { X } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/cn";
import { Input } from "@/components/ui";
import { addChip, removeChip } from "./logic";

export interface ChipInputProps {
  /** Names the list for assistive tech ("Roles"). */
  label: string;
  values: readonly string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  invalid?: boolean;
  className?: string;
  "data-testid"?: string;
}

/**
 * Chips with × and a "+ add, press ⏎" input (prototype criteria lists, master CV tags).
 * Duplicates (case-insensitive) and blanks are ignored. Candidate for components/ui.
 */
export function ChipInput({ label, values, onChange, placeholder = "+ add, press ⏎", invalid, className, "data-testid": testId }: ChipInputProps) {
  const [draft, setDraft] = useState("");
  return (
    <div role="group" aria-label={label} data-testid={testId} className={cn("flex flex-wrap items-center gap-2", className)}>
      {values.map((chip, i) => (
        <span key={chip} className="flex items-center gap-1.5 rounded-full border border-border bg-surface-2 px-3 py-1 text-xs">
          <span>{chip}</span>
          <button
            type="button"
            aria-label={`Remove ${chip}`}
            onClick={() => onChange(removeChip(values, i))}
            className="grid size-4 place-items-center rounded-full text-muted transition hover:text-danger"
          >
            <X aria-hidden className="size-3" />
          </button>
        </span>
      ))}
      {/* Input is w-full; the wrapper sets the width (cn does not merge classes). */}
      <div className="w-40">
        <Input
          aria-label={`Add to ${label}`}
          value={draft}
          invalid={invalid}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            if (!draft.trim()) return;
            onChange(addChip(values, draft));
            setDraft("");
          }}
          className="py-1 text-xs"
        />
      </div>
    </div>
  );
}

export interface ToggleChipsProps<V extends string> {
  label: string;
  options: readonly { value: V; label: string }[];
  values: readonly V[];
  onToggle: (value: V) => void;
  invalid?: boolean;
  "data-testid"?: string;
}

/** Multi-select pills (prototype sources, work mode, seniority): aria-pressed toggles. */
export function ToggleChips<V extends string>({ label, options, values, onToggle, invalid, "data-testid": testId }: ToggleChipsProps<V>) {
  return (
    <div role="group" aria-label={label} data-testid={testId} className="flex flex-wrap gap-2">
      {options.map((o) => {
        const on = values.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(o.value)}
            className={cn(
              "rounded-full px-3 py-1 text-xs transition",
              on ? "bg-gradient-brand text-white shadow-glow" : "border text-muted hover:text-fg",
              !on && (invalid ? "border-danger" : "border-border hover:border-accent"),
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
