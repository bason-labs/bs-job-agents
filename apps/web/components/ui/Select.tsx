"use client";

import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/cn";
import { moveIndex, typeaheadIndex } from "@/lib/listNav";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  options: readonly SelectOption[];
  value: string | null;
  onValueChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  size?: "sm" | "md";
  id?: string;
  /** Renders a hidden input so the value posts with a <form>. */
  name?: string;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "data-testid"?: string;
}

const TYPEAHEAD_RESET_MS = 500;

/**
 * Themed select (spec §11; prototype `uiSelect`). Focus stays on the trigger
 * (combobox + aria-activedescendant). ↑/↓ open and move, Enter/Space choose,
 * Esc closes, letters jump (type-ahead). The list renders in a portal via the
 * Radix Popover primitive, which also handles click-outside and positioning,
 * so tables and cards never clip it.
 */
export function Select({
  options,
  value,
  onValueChange,
  placeholder = "Select…",
  disabled = false,
  invalid = false,
  size = "md",
  id,
  name,
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "data-testid": testId,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ query: "", at: 0 });
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const openList = useCallback(() => {
    if (disabled) return;
    const start = selectedIndex >= 0 && !options[selectedIndex]!.disabled ? selectedIndex : moveIndex(options, -1, 1);
    setActive(start);
    setOpen(true);
  }, [disabled, options, selectedIndex]);

  const choose = (i: number) => {
    const opt = options[i];
    if (!opt || opt.disabled) return;
    if (opt.value !== value) onValueChange(opt.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  // Keep the active option visible inside the list (no page scroll).
  useEffect(() => {
    if (!open || active < 0) return;
    const frame = requestAnimationFrame(() => {
      const list = listRef.current;
      const el = list?.querySelector<HTMLElement>(`[data-index="${active}"]`);
      if (!list || !el) return;
      const top = el.offsetTop;
      const bottom = top + el.offsetHeight;
      if (top < list.scrollTop) list.scrollTop = top - 4;
      else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight + 4;
    });
    return () => cancelAnimationFrame(frame);
  }, [open, active]);

  const onTypeahead = (char: string) => {
    const now = Date.now();
    const t = typeahead.current;
    t.query = now - t.at > TYPEAHEAD_RESET_MS ? char : t.query + char;
    t.at = now;
    const from = open ? active : selectedIndex;
    const i = typeaheadIndex(options, t.query, from < 0 ? options.length - 1 : from);
    if (i < 0) return;
    if (open) setActive(i);
    else if (options[i]!.value !== value) onValueChange(options[i]!.value);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp": {
        e.preventDefault();
        if (!open) openList();
        else setActive((a) => moveIndex(options, a, e.key === "ArrowDown" ? 1 : -1));
        return;
      }
      case "Home":
      case "End": {
        if (!open) return;
        e.preventDefault();
        setActive(e.key === "Home" ? moveIndex(options, -1, 1) : moveIndex(options, options.length, -1));
        return;
      }
      case "Enter":
      case " ": {
        // A space in the middle of a type-ahead query is part of the query.
        if (e.key === " " && Date.now() - typeahead.current.at < TYPEAHEAD_RESET_MS) {
          e.preventDefault();
          onTypeahead(" ");
          return;
        }
        e.preventDefault();
        if (open) choose(active);
        else openList();
        return;
      }
      case "Escape": {
        if (!open) return;
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        return;
      }
      case "Tab": {
        if (open) setOpen(false);
        return;
      }
      default: {
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          onTypeahead(e.key);
        }
      }
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={(next) => (next ? openList() : setOpen(false))}>
      <Popover.Trigger
        asChild
        aria-haspopup="listbox"
        aria-controls={listId}
      >
        <button
          ref={triggerRef}
          type="button"
          id={id}
          role="combobox"
          aria-controls={listId}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          aria-expanded={open}
          aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
          aria-invalid={invalid || undefined}
          disabled={disabled}
          data-testid={testId}
          onKeyDown={onKeyDown}
          // Space is handled on keydown; stop the native keyup click from toggling again.
          onKeyUp={(e) => e.key === " " && e.preventDefault()}
          className={cn(
            "flex w-full items-center justify-between gap-2 rounded-xl border bg-surface text-left text-fg transition disabled:opacity-50",
            size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-2 text-sm",
            open ? "border-accent shadow-glow" : invalid ? "border-danger" : "border-border hover:border-accent",
            className,
          )}
        >
          <span className={cn("truncate", !selected && "text-muted")}>{selected ? selected.label : placeholder}</span>
          <ChevronDown aria-hidden className={cn("size-4 shrink-0 text-muted transition-transform", open && "rotate-180")} />
        </button>
      </Popover.Trigger>
      {name ? <input type="hidden" name={name} value={value ?? ""} /> : null}
      <Popover.Portal>
        <Popover.Content
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          // Keep focus on the trigger while clicking options.
          onMouseDown={(e) => e.preventDefault()}
          style={{ minWidth: "var(--radix-popover-trigger-width)" }}
          className="relative z-50 max-h-60 w-max overflow-auto rounded-xl border border-border bg-surface p-1 shadow-2xl"
        >
          {options.map((opt, i) => {
            const isSelected = opt.value === value;
            return (
              <div
                key={opt.value}
                id={optionId(i)}
                role="option"
                data-index={i}
                aria-selected={isSelected}
                aria-disabled={opt.disabled || undefined}
                onMouseEnter={() => !opt.disabled && setActive(i)}
                onClick={() => choose(i)}
                className={cn(
                  "flex w-full items-center justify-between gap-4 rounded-lg px-3 py-1.5 text-left text-sm select-none",
                  i === active && "bg-surface-2",
                  opt.disabled && "opacity-40",
                )}
              >
                <span>{opt.label}</span>
                {isSelected ? <Check aria-hidden className="size-4 text-accent" /> : <span className="size-4" />}
              </div>
            );
          })}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
