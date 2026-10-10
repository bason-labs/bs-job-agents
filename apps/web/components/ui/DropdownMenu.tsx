"use client";

import * as RadixMenu from "@radix-ui/react-dropdown-menu";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "@/lib/cn";

export const DropdownMenu = RadixMenu.Root;
export const DropdownMenuTrigger = RadixMenu.Trigger;

/** Always rendered in a portal, so tables and overflow containers never clip it (spec §11). */
export function DropdownMenuContent({ className, align = "end", sideOffset = 6, ...props }: ComponentPropsWithoutRef<typeof RadixMenu.Content>) {
  return (
    <RadixMenu.Portal>
      <RadixMenu.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn("z-50 min-w-48 rounded-2xl border border-border bg-surface p-1 text-sm shadow-2xl", className)}
        {...props}
      />
    </RadixMenu.Portal>
  );
}

export function DropdownMenuItem({
  className,
  icon,
  danger = false,
  children,
  ...props
}: ComponentPropsWithoutRef<typeof RadixMenu.Item> & { icon?: ReactNode; danger?: boolean }) {
  return (
    <RadixMenu.Item
      className={cn(
        "flex items-center gap-2 rounded-xl px-3 py-2 outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-2",
        danger ? "text-danger" : "text-fg",
        "[&_svg]:size-4 [&_svg]:shrink-0",
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </RadixMenu.Item>
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentPropsWithoutRef<typeof RadixMenu.Label>) {
  return <RadixMenu.Label className={cn("px-3 py-1.5 text-[10px] tracking-wider text-muted uppercase", className)} {...props} />;
}

export function DropdownMenuSeparator({ className, ...props }: ComponentPropsWithoutRef<typeof RadixMenu.Separator>) {
  return <RadixMenu.Separator className={cn("my-1 h-px bg-border", className)} {...props} />;
}
