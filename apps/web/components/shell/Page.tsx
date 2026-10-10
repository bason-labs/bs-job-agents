import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { EmptyState } from "@/components/ui/EmptyState";

/**
 * Layout rule (spec §11): constrained pages are centered (mx-auto + max-w);
 * chat and flows use the full width.
 * - narrow: forms and lists (Search criteria, Schedules, Master CV, Bots)
 * - wide: tables and queues (Applications, Review)
 * - full: Chat, Flow canvas, Rooms (they manage their own scrolling)
 */
export type PageWidth = "narrow" | "wide" | "full";

const WIDTHS: Record<Exclude<PageWidth, "full">, string> = {
  narrow: "max-w-3xl",
  wide: "max-w-5xl",
};

export function Page({ width = "narrow", className, children }: { width?: PageWidth; className?: string; children: ReactNode }) {
  if (width === "full") {
    return (
      <div data-testid="page" data-width="full" className={cn("flex min-h-0 w-full flex-1 flex-col", className)}>
        {children}
      </div>
    );
  }
  return (
    <div data-testid="page" data-width={width} className={cn("mx-auto w-full space-y-4 p-5", WIDTHS[width], className)}>
      {children}
    </div>
  );
}

/** Phase-1 stand-in for screens built in Phase 3. */
export function PlaceholderPage({
  width = "narrow",
  heading,
  description,
  icon,
}: {
  width?: PageWidth;
  heading: string;
  description: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <Page width={width} className={width === "full" ? "items-center justify-center p-5" : undefined}>
      <EmptyState
        className={width === "full" ? "w-full max-w-2xl" : undefined}
        icon={icon}
        title={heading}
        description={description}
      />
    </Page>
  );
}
