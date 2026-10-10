"use client";

import * as RadixPopover from "@radix-ui/react-popover";
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/cn";

export const Popover = RadixPopover.Root;
export const PopoverTrigger = RadixPopover.Trigger;
export const PopoverClose = RadixPopover.Close;

/** Floating panel in a portal (never clipped). */
export function PopoverContent({ className, align = "start", sideOffset = 6, ...props }: ComponentPropsWithoutRef<typeof RadixPopover.Content>) {
  return (
    <RadixPopover.Portal>
      <RadixPopover.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn("z-50 w-72 rounded-2xl border border-border bg-surface p-3 text-sm shadow-2xl outline-none", className)}
        {...props}
      />
    </RadixPopover.Portal>
  );
}
