"use client";

import { API_ROUTES, ChromeBrowserViewSchema, type ChromeBrowser, type ChromeBrowserView } from "@bs-job-agents/shared";
import { Globe } from "lucide-react";
import { useState } from "react";
import { errorText } from "@/components/schedules/apiError";
import { formatDateTime } from "@/components/schedules/datetime";
import { Badge, Button, Skeleton, useToast } from "@/components/ui";
import type { WebApi } from "@/lib/api/contract";
import { useLiveResource } from "@/lib/api/live-resource";
import { useApi } from "@/lib/api/react";

/** GET/PUT /settings/chrome-browser. */
export function createChromeBrowserData(api: Pick<WebApi, "request">) {
  return {
    get: () => api.request("GET", API_ROUTES.chromeBrowser, { schema: ChromeBrowserViewSchema }),
    set: (deviceId: string | null) => api.request("PUT", API_ROUTES.chromeBrowser, { body: { deviceId }, schema: ChromeBrowserViewSchema }),
  };
}

/** "Ba's MacBook Pro · macOS · this computer" */
export function browserLabel(b: Pick<ChromeBrowser, "deviceId" | "name" | "os" | "isLocal">): string {
  return [b.name ?? `Browser ${b.deviceId.slice(0, 8)}`, b.os, b.isLocal ? "this computer" : null].filter(Boolean).join(" · ");
}

/**
 * Live 2026-10-20: with two Claude in Chrome extensions connected, a bot cannot act until one is
 * selected, and bots never choose. Ba picks the browser bots use here; the list is what the bots'
 * Chrome tools reported. A task that met several browsers waits with a Resume card in chat.
 */
export function ChromeBrowserSetting() {
  const api = useApi();
  const [data] = useState(() => createChromeBrowserData(api));
  const res = useLiveResource("w3c:chrome-browser", () => data.get(), { refreshOn: (e) => e.type === "task.paused" });
  const [busy, setBusy] = useState<string | null>(null);
  const { toast } = useToast();
  const view: ChromeBrowserView | undefined = res.data;

  const choose = async (deviceId: string | null) => {
    setBusy(deviceId ?? "clear");
    try {
      const next = await data.set(deviceId);
      res.mutate(() => next);
      toast({ title: next.preferred ? `Bots use ${browserLabel(next.preferred)}` : "No browser chosen: bots pause when several are connected" });
    } catch (e) {
      toast({ title: `Couldn't save the browser: ${errorText(e)}`, tone: "err" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="chrome-browser-title" data-testid="chrome-browser" className="mt-6 space-y-3 rounded-3xl border border-border bg-surface/60 p-4">
      <div className="flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-2xl bg-surface-2 text-accent">
          <Globe aria-hidden className="size-4" />
        </div>
        <div>
          <h2 id="chrome-browser-title" className="font-display font-semibold">
            Chrome browser for bots
          </h2>
          <p className="text-xs text-muted">
            When more than one Chrome browser with the Claude extension is connected, bots use only the one you pick here; they never choose one themselves. Without a choice, they pause and ask.
          </p>
        </div>
      </div>
      {view === undefined ? (
        res.error ? (
          <p className="text-xs text-danger">Couldn&apos;t load the browsers: {errorText(res.error)}</p>
        ) : (
          <Skeleton className="h-12 w-full" />
        )
      ) : view.seen.length === 0 ? (
        <p className="text-xs text-muted italic">No browser reported yet. Browsers appear here once a bot has seen them (for example when several were connected).</p>
      ) : (
        <ul className="space-y-2">
          {view.seen.map((b) => {
            const chosen = view.preferred?.deviceId === b.deviceId;
            return (
              <li key={b.deviceId} data-testid="chrome-browser-option" data-chosen={chosen} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-border bg-surface-2/40 p-3 text-xs">
                <span>
                  <span className="font-medium">{browserLabel(b)}</span>
                  <span className="ml-2 text-[11px] text-muted">seen {formatDateTime(b.seenAt)}</span>
                </span>
                {chosen ? (
                  <span className="flex items-center gap-2">
                    <Badge tone="ok" className="px-1.5 text-[10px]">
                      bots use this one
                    </Badge>
                    <Button size="sm" pill variant="ghost" loading={busy === "clear"} disabled={busy !== null} onClick={() => void choose(null)}>
                      Clear
                    </Button>
                  </span>
                ) : (
                  <Button size="sm" pill variant="secondary" loading={busy === b.deviceId} disabled={busy !== null} onClick={() => void choose(b.deviceId)} aria-label={`Use ${browserLabel(b)} for bots`}>
                    Use for bots
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
