"use client";

import Link from "next/link";
import type { BotSummary } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { botChatHref } from "@/lib/routes";

/** Bot tabs at the top of the chat (Lead default; the others open consult threads, UC-25). */
export function BotTabs({ bots, active }: { bots: readonly BotSummary[]; active: string }) {
  return (
    <nav aria-label="Bots" className="flex flex-wrap items-center gap-1.5">
      {bots.map((b) => {
        const on = b.name === active;
        return (
          <Link
            key={b.name}
            href={botChatHref(b.name)}
            aria-current={on ? "page" : undefined}
            className={cn(
              "rounded-full px-3 py-1 text-xs transition",
              on ? "bg-gradient-brand text-white shadow-glow" : "border border-border bg-surface/70 text-muted hover:text-fg",
            )}
          >
            {b.displayName}
          </Link>
        );
      })}
    </nav>
  );
}
