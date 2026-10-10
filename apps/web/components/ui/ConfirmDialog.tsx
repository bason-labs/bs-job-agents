"use client";

import type { ReactNode } from "react";
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
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={title}
        description={description}
        hideClose
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
