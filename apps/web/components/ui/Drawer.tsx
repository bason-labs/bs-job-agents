"use client";

import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** Small caps line above the title (e.g. "Research · Codex"). */
  eyebrow?: ReactNode;
  children: ReactNode;
  /** md = 420px (step drawer, prototype), lg = 480px (submission record panel). */
  size?: "md" | "lg";
  className?: string;
  "data-testid"?: string;
}

const WIDTHS = { md: "sm:w-[420px]", lg: "sm:w-[480px]" } as const;

/**
 * Side panel from the right (prototype drawers: the step drawer, UC-22, and the submission record
 * panel, UC-13). Modal: dim backdrop, Esc / ✕ / backdrop click close it, focus stays inside.
 */
export function Drawer({ open, onOpenChange, title, eyebrow, children, size = "md", className, "data-testid": testId }: DrawerProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <RadixDialog.Content
          data-testid={testId}
          aria-describedby={undefined}
          className={cn(
            "fixed inset-y-0 right-0 z-50 flex w-full flex-col overflow-hidden border-l border-border bg-surface shadow-2xl outline-none",
            WIDTHS[size],
            className,
          )}
        >
          <div className="flex items-start justify-between gap-3 border-b border-border/60 p-5">
            <div className="min-w-0">
              {eyebrow ? <p className="text-[10px] tracking-wider text-muted uppercase">{eyebrow}</p> : null}
              <RadixDialog.Title className="font-display text-lg font-semibold">{title}</RadixDialog.Title>
            </div>
            <RadixDialog.Close aria-label="Close" title="Close (Esc)" className="-mt-1 -mr-1 grid size-8 shrink-0 place-items-center rounded-xl text-muted hover:bg-surface-2 hover:text-fg">
              <X aria-hidden className="size-4" />
            </RadixDialog.Close>
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">{children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
