"use client";

import { RefreshCw, WifiOff } from "lucide-react";
import type { ReactNode } from "react";
import { Button, EmptyState, Skeleton } from "@/components/ui";
import type { Resource } from "@/lib/api/react";
import { errorText } from "./apiError";

export interface ResourceGateProps<T> {
  resource: Resource<T>;
  /** "applications", "search criteria" … for the error text. */
  label: string;
  /** Placeholder rows while the first read is in flight. */
  rows?: number;
  children: (data: T) => ReactNode;
}

/**
 * The W3c screens' first read: a skeleton while it loads, an error with Retry when it fails
 * (an unreachable orchestrator, a degraded start), then the screen. Later re-reads keep the
 * last data on screen.
 */
export function ResourceGate<T>({ resource, label, rows = 4, children }: ResourceGateProps<T>) {
  if (resource.data !== undefined) return <>{children(resource.data)}</>;
  if (resource.error && !resource.loading) {
    return (
      <EmptyState
        icon={<WifiOff aria-hidden />}
        title={`Couldn't load the ${label}`}
        description={<span data-testid="resource-error">{errorText(resource.error)}</span>}
        action={
          <Button pill onClick={() => void resource.reload()} leftIcon={<RefreshCw aria-hidden className="size-4" />}>
            Retry
          </Button>
        }
      />
    );
  }
  return (
    <div className="space-y-3" aria-busy aria-label={`Loading the ${label}`} data-testid="resource-loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-14 w-full" />
      ))}
    </div>
  );
}
