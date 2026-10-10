"use client";

import * as RadixDialog from "@radix-ui/react-dialog";
import { Menu } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useReducer, useState, type ReactNode } from "react";
import { applyShellEvent, subscribeShellEvents } from "@/lib/api/live";
import type { ShellData } from "@/lib/api/types";
import { titleForPath } from "@/lib/routes";
import { useHydrated } from "@/lib/useHydrated";
import { secondsUntil, useNow } from "@/lib/useNow";
import { IconButton } from "@/components/ui/IconButton";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { Sidebar } from "./Sidebar";

export interface AppShellProps {
  data: ShellData;
  children: ReactNode;
}

/**
 * Prototype layout: floating sidebar card + main card with a top bar.
 * Below md the sidebar becomes a drawer opened from the top bar.
 */
export function AppShell({ data: initialData, children }: AppShellProps) {
  const pathname = usePathname() ?? "/";
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Server data seeds the sidebar; live events (lib/api/live) keep it current.
  const [data, dispatch] = useReducer(applyShellEvent, initialData);
  useEffect(() => subscribeShellEvents(dispatch), []);
  const title = titleForPath(pathname, data.bots, data.rooms);
  const hydrated = useHydrated();

  return (
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
            <ThemeToggle />
          </div>
        </header>
        <PausedBanner data={data} />
        <main id="main" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {children}
        </main>
      </section>
    </div>
  );
}

/** Engine paused / Chrome disconnected banner (spec §11 Sidebar key state, UC-16). */
function PausedBanner({ data }: { data: ShellData }) {
  const paused = data.usage.filter((u) => u.pausedUntil);
  const now = useNow(paused.length > 0);
  if (!paused.length && data.chromeConnected) return null;
  return (
    <div role="status" className="mx-3 mt-3 flex flex-wrap gap-4 rounded-2xl border border-warn/40 bg-warn/10 px-4 py-2 text-xs text-warn md:mx-5">
      {paused.map((u) => {
        const left = secondsUntil(u.pausedUntil, now);
        return (
          <span key={u.engine}>
            ⏸ {u.label} paused (usage limit) — auto-resume{left !== null ? <> in <b>{left}</b>s</> : null}
          </span>
        );
      })}
      {data.chromeConnected ? null : <span>🌐 Chrome not connected — browser steps waiting</span>}
    </div>
  );
}
