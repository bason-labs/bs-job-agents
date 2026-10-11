"use client";

import type { ReactNode, RefObject } from "react";
import { Button } from "./Button";
import { Dialog, DialogContent } from "./Dialog";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** danger = destructive (red); brand = gradient primary. */
  tone?: "danger" | "brand";
  loading?: boolean;
  onConfirm: () => void;
  /** Element to focus on close; by default the one focused when the dialog opened. */
  returnFocus?: RefObject<HTMLElement | null>;
}

/** Prototype confirm modal (e.g. "Delete schedule"). Pair destructive actions with an Undo toast. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "danger",
  loading = false,
  onConfirm,
  returnFocus,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={title}
        description={description}
        hideClose
        returnFocus={returnFocus}
        data-testid="confirm-dialog"
        footer={
          <>
            <Button pill onClick={() => onOpenChange(false)}>
              {cancelLabel}
            </Button>
            <Button pill variant={tone === "danger" ? "danger" : "primary"} loading={loading} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </>
        }
      />
    </Dialog>
  );
}
