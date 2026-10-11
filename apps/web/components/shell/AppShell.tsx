"use client";

import * as RadixDialog from "@radix-ui/react-dialog";
import { Menu, RefreshCw } from "lucide-react";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import type { HealthState } from "@/lib/api/contract";
import { affectsReviewCount, applyShellEvent, subscribeShellEvents } from "@/lib/api/live";
import { useApi, useAppEvents, useDebounced, useFeedStatus } from "@/lib/api/react";
import type { ShellData } from "@/lib/api/types";
import { titleForPath } from "@/lib/routes";
import { useHydrated } from "@/lib/useHydrated";
import { IconButton } from "@/components/ui/IconButton";
import { useReturnFocus } from "@/components/ui/focus";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { MockMenu } from "./MockMenu";
import { ShellContext } from "./ShellContext";
import { Sidebar } from "./Sidebar";
import { HealthBanner, PausedBanner } from "./StatusBanners";

export interface AppShellProps {
  data: ShellData;
  /** The orchestrator's /health when the page was rendered (PM S19 degraded start, unreachable). */
  health?: HealthState;
  children: ReactNode;
}

const HEALTHY: HealthState = { ok: true, reason: null, detail: null };

/**
 * Prototype layout: floating sidebar card + main card with a top bar.
 * Below md the sidebar becomes a drawer opened from the top bar.
 * Server data seeds the sidebar; the api's live events keep it current.
 */
export function AppShell({ data: initialData, health: initialHealth = HEALTHY, children }: AppShellProps) {
  const api = useApi();
  const pathname = usePathname() ?? "/";
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [data, dispatch] = useReducer(applyShellEvent, initialData);
  const [health, setHealth] = useState(initialHealth);
  const feedStatus = useFeedStatus();
  const hydrated = useHydrated();
  const drawerFocus = useReturnFocus();

  useEffect(() => subscribeShellEvents(api.events, dispatch), [api]);

  // The review count is re-read rather than guessed from events.
  const refreshReviewCount = useDebounced(() => {
    api.getReviewQueue().then(
      (cards) => dispatch({ type: "review.count", reviewCount: cards.length }),
      () => {},
    );
  }, 300);
  useAppEvents((event) => {
    if (affectsReviewCount(event)) refreshReviewCount();
  });

  // After the live connection comes back (orchestrator restarted), re-read the whole shell.
  const wasOpen = useRef(feedStatus === "open");
  useEffect(() => {
    if (feedStatus === "open" && !wasOpen.current) {
      void api.getHealth().then(setHealth);
      api.getShellData().then(
        (fresh) => dispatch({ type: "shell.replace", data: fresh }),
        () => {},
      );
    }
    wasOpen.current = feedStatus === "open";
  }, [api, feedStatus]);

  // While live updates are down, say why: unreachable, or a degraded start (/events answers 503).
  useEffect(() => {
    if (api.mode !== "live" || feedStatus !== "reconnecting") return;
    const check = () => void api.getHealth().then(setHealth);
    check();
    const timer = setInterval(check, 15_000);
    return () => clearInterval(timer);
  }, [api, feedStatus]);

  const refresh = useCallback(() => {
    api.getShellData().then(
      (fresh) => dispatch({ type: "shell.replace", data: fresh }),
      () => {},
    );
  }, [api]);

  const title = titleForPath(pathname, data.bots, data.rooms);
  const shell = useMemo(() => ({ data, health, refresh }), [data, health, refresh]);

  return (
    <ShellContext.Provider value={shell}>
      <div data-hydrated={hydrated || undefined} className="flex h-dvh gap-3 p-0 text-sm md:p-3">
        <aside
          aria-label="Sidebar"
          data-testid="sidebar"
          className="hidden w-60 shrink-0 overflow-hidden rounded-3xl border border-border bg-surface/50 backdrop-blur-md md:flex md:flex-col"
        >
          <Sidebar data={data} />
        </aside>

        <RadixDialog.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
          <RadixDialog.Portal>
            <RadixDialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm md:hidden" />
            <RadixDialog.Content
              data-testid="sidebar-drawer"
              {...drawerFocus}
              aria-describedby={undefined}
              className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-border bg-surface text-sm shadow-2xl outline-none md:hidden"
            >
              <RadixDialog.Title className="sr-only">Navigation</RadixDialog.Title>
              <Sidebar data={data} onNavigate={() => setDrawerOpen(false)} />
            </RadixDialog.Content>
          </RadixDialog.Portal>
        </RadixDialog.Root>

        <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden border-border bg-surface/50 backdrop-blur-md md:rounded-3xl md:border">
          <header className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-3 md:px-5">
            <div className="flex min-w-0 items-center gap-2">
              <IconButton
                label="Open navigation"
                icon={<Menu aria-hidden />}
                className="md:hidden"
                onClick={() => setDrawerOpen(true)}
                data-testid="open-navigation"
              />
              <h1 data-testid="page-title" className="truncate font-display font-semibold text-fg">
                {title}
              </h1>
            </div>
            <div className="flex items-center gap-2">
              {api.mode === "live" && feedStatus === "reconnecting" ? (
                <span role="status" data-testid="live-reconnecting" className="hidden items-center gap-1.5 text-xs text-warn sm:inline-flex">
                  <RefreshCw aria-hidden className="size-3.5 animate-spin" /> Reconnecting live updates…
                </span>
              ) : null}
              <MockMenu />
              <ThemeToggle />
            </div>
          </header>
          {api.mode === "live" ? <HealthBanner health={health} /> : null}
          <PausedBanner data={data} />
          <main id="main" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            {children}
          </main>
        </section>
      </div>
    </ShellContext.Provider>
  );
}
