"use client";

import * as RadixTabs from "@radix-ui/react-tabs";
import { createContext, useContext, type ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/cn";

type TabsVariant = "pill" | "underline";
const VariantContext = createContext<TabsVariant>("pill");

export function Tabs({ variant = "pill", ...props }: ComponentPropsWithoutRef<typeof RadixTabs.Root> & { variant?: TabsVariant }) {
  return (
    <VariantContext.Provider value={variant}>
      <RadixTabs.Root {...props} />
    </VariantContext.Provider>
  );
}

export function TabsList({ className, ...props }: ComponentPropsWithoutRef<typeof RadixTabs.List>) {
  const variant = useContext(VariantContext);
  return (
    <RadixTabs.List
      className={cn(variant === "pill" ? "flex flex-wrap items-center gap-1.5" : "flex items-center gap-4 border-b border-border", className)}
      {...props}
    />
  );
}

/** Pill tabs match the chat bot tabs in the prototype; underline suits page sections. */
export function TabsTrigger({ className, ...props }: ComponentPropsWithoutRef<typeof RadixTabs.Trigger>) {
  const variant = useContext(VariantContext);
  return (
    <RadixTabs.Trigger
      className={cn(
        "text-xs transition disabled:opacity-50",
        variant === "pill"
          ? "rounded-full border border-border bg-surface/70 px-3 py-1 text-muted hover:text-fg data-[state=active]:border-transparent data-[state=active]:bg-gradient-brand data-[state=active]:text-white data-[state=active]:shadow-glow"
          : "-mb-px border-b-2 border-transparent px-1 pb-2 text-sm text-muted hover:text-fg data-[state=active]:border-accent data-[state=active]:text-fg",
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentPropsWithoutRef<typeof RadixTabs.Content>) {
  return <RadixTabs.Content className={cn("mt-3 outline-none", className)} {...props} />;
}
