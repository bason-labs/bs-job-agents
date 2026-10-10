"use client";

import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

export interface DialogContentProps {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  /** Hide the ✕ (e.g. ConfirmDialog, which has Cancel). */
  hideClose?: boolean;
  className?: string;
  "data-testid"?: string;
}

const WIDTHS = { sm: "max-w-sm", md: "max-w-[460px]", lg: "max-w-2xl" } as const;

/** Prototype modal: dim backdrop, centered rounded-3xl card. Esc and backdrop click close it. */
export function DialogContent({ title, description, children, footer, size = "md", hideClose = false, className, "data-testid": testId }: DialogContentProps) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" />
      <RadixDialog.Content
        data-testid={testId}
        className={cn(
          "fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto",
          "space-y-4 rounded-3xl border border-border bg-surface p-5 shadow-2xl outline-none",
          WIDTHS[size],
          className,
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <RadixDialog.Title className="font-display text-lg font-semibold">{title}</RadixDialog.Title>
            {description ? (
              <RadixDialog.Description className="text-xs text-muted">{description}</RadixDialog.Description>
            ) : (
              <RadixDialog.Description className="sr-only">{title}</RadixDialog.Description>
            )}
          </div>
          {hideClose ? null : (
            <RadixDialog.Close aria-label="Close" className="-mt-1 -mr-1 grid size-8 place-items-center rounded-xl text-muted hover:bg-surface-2 hover:text-fg">
              <X aria-hidden className="size-4" />
            </RadixDialog.Close>
          )}
        </div>
        {children}
        {footer ? <div className="flex flex-wrap justify-end gap-2">{footer}</div> : null}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}
