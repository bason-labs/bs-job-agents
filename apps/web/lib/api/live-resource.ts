"use client";

// A screen's read that stays current: useResource plus a debounced re-read whenever a live event
// says the data may have changed (e.g. application.updated for the Applications table).
import type { AppEvent } from "@bs-job-agents/shared";
import type { WebApi } from "./contract";
import { useAppEvents, useDebounced, useResource, type Resource } from "./react";

export interface LiveResourceOptions {
  /** Live events after which the data is read again (debounced). */
  refreshOn?: (event: AppEvent) => boolean;
  debounceMs?: number;
}

export function useLiveResource<T>(key: string | null, load: (api: WebApi) => Promise<T>, opts: LiveResourceOptions = {}): Resource<T> {
  const res = useResource(key, load);
  const refresh = useDebounced(() => void res.reload(), opts.debounceMs ?? 300);
  useAppEvents((e) => {
    if (opts.refreshOn?.(e)) refresh();
  });
  return res;
}
