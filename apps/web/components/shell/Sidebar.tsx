"use client";

import { Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ShellData } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { NAV_ITEMS, botChatHref, botSettingsHref, isNavActive, isTeamActive, roomHref } from "@/lib/routes";
import { secondsUntil, useNow } from "@/lib/useNow";
import { BotAvatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { UsageMeter } from "@/components/ui/ProgressBar";
import { StatusDot } from "@/components/ui/StatusDot";
import { TrustBadge } from "@/components/ui/TrustBadge";

export interface SidebarProps {
  data: ShellData;
  /** Called after any link click (closes the mobile drawer). */
  onNavigate?: () => void;
  className?: string;
}

const rowBase = "rounded-lg px-3 hover:bg-surface-2 transition-colors";

/** Left sidebar, as in the stage-0 prototype (spec §11 Sidebar row). */
export function Sidebar({ data, onNavigate, className }: SidebarProps) {
  const pathname = usePathname() ?? "/";
  const anyPaused = data.usage.some((u) => u.pausedUntil);
  const now = useNow(anyPaused);

  return (
    <div className={cn("flex h-full flex-col overflow-y-auto", className)}>
      <div className="flex items-center gap-2 px-4 py-4">
        <div className="grid size-8 place-items-center rounded-xl bg-gradient-brand font-display font-bold text-white shadow-glow">J</div>
        <span className="font-display font-semibold tracking-tight">Job Agents</span>
      </div>

      <nav aria-label="Main" className="space-y-0.5 px-2">
        {NAV_ITEMS.map((item) => {
          const active = isNavActive(item.href, pathname);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn("flex items-center justify-between py-2", rowBase, active ? "bg-surface-2 text-fg" : "text-muted")}
            >
              <span>{item.label}</span>
              {item.href === "/review" && data.reviewCount > 0 ? (
                <Badge count aria-label={`${data.reviewCount} waiting`}>
                  {data.reviewCount}
                </Badge>
              ) : null}
              {item.href === "/flows" && data.activeRunId ? (
                <span aria-label="Run in progress" role="img" className="size-1.5 animate-pulse rounded-full bg-accent" />
              ) : null}
            </Link>
          );
        })}
      </nav>

      <div className="mt-4 mb-1 flex items-center justify-between px-5">
        <p id="sidebar-team" className="text-[10px] tracking-wider text-muted uppercase">
          Team
        </p>
        <Link href="/bots" onClick={onNavigate} className="text-[10px] text-muted hover:text-fg">
          Manage
        </Link>
      </div>
      <ul aria-labelledby="sidebar-team" className="space-y-0.5 px-2">
        {data.bots.map((bot) => {
          const active = isTeamActive(bot.name, pathname);
          return (
            <li key={bot.name} className={cn("group flex items-center rounded-lg pr-3 transition-colors hover:bg-surface-2", active && "bg-surface-2")}>
              <Link
                href={botChatHref(bot.name)}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                aria-label={`Chat with ${bot.displayName}`}
                title={`Chat with ${bot.displayName}`}
                className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-lg py-1.5 pl-3"
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <BotAvatar name={bot.displayName} lead={bot.name === "lead"} />
                  <span className="truncate">{bot.displayName}</span>
                </span>
                <span className="flex items-center gap-1.5">
                  {bot.status === "working" ? <span className="text-[10px] text-accent">working</span> : null}
                  <TrustBadge level={bot.trustLevel} />
                </span>
              </Link>
              <Link
                href={botSettingsHref(bot.name)}
                onClick={onNavigate}
                aria-label={`${bot.displayName} settings`}
                title="Bot settings"
                className="grid h-5 w-0 place-items-center overflow-hidden rounded text-muted opacity-0 transition-[width,opacity] group-hover:mx-1 group-hover:w-5 group-hover:opacity-100 hover:text-fg focus-visible:mx-1 focus-visible:w-5 focus-visible:opacity-100"
              >
                <Settings aria-hidden className="size-3.5" />
              </Link>
              <StatusDot status={bot.status} className="ml-1.5" />
            </li>
          );
        })}
      </ul>

      <p className="mt-4 mb-1 px-5 text-[10px] tracking-wider text-muted uppercase">Rooms</p>
      <div className="flex flex-col gap-0.5 px-2">
        {data.rooms.map((room) => {
          const href = roomHref(room.id);
          const active = pathname === href;
          return (
            <Link
              key={room.id}
              href={href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn("py-1.5", rowBase, active ? "bg-surface-2 text-fg" : "text-muted")}
            >
              # {room.name}
            </Link>
          );
        })}
        <Link
          href="/cv"
          onClick={onNavigate}
          aria-current={pathname === "/cv" ? "page" : undefined}
          className={cn("mt-3 py-1.5", rowBase, pathname === "/cv" ? "bg-surface-2 text-fg" : "text-muted")}
        >
          Master CV
        </Link>
      </div>

      <div className="m-3 mt-auto space-y-1.5 rounded-2xl border border-border bg-surface-2/50 p-3">
        <p className="text-xs font-medium">Subscriptions</p>
        {data.usage.map((u) => (
          <UsageMeter key={u.engine} label={u.label} utilization={u.utilization} resumesInSeconds={secondsUntil(u.pausedUntil, now)} />
        ))}
        <div className="flex justify-between pt-1 text-[10px]">
          <span className="text-muted">Chrome extension</span>
          <span className={data.chromeConnected ? "text-ok" : "text-warn"}>{data.chromeConnected ? "connected" : "not connected"}</span>
        </div>
      </div>
    </div>
  );
}
