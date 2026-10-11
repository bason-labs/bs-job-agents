"use client";

import { CalendarClock, ChevronDown, ExternalLink, Frame, Globe, KeyRound, PauseCircle, PlayCircle, ShieldQuestion } from "lucide-react";
import type { ReactNode } from "react";
import type { SimulationKind } from "@/lib/api/mock/backend";
import { useApi, type LazyMockApi } from "@/lib/api/react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { Tooltip } from "@/components/ui/Tooltip";

const ITEMS: Array<{ kind: SimulationKind; label: string; icon: ReactNode } | "sep"> = [
  { kind: "scheduled-scan", label: "Scheduled scan fires (UC-02)", icon: <CalendarClock aria-hidden /> },
  "sep",
  { kind: "claude-limit", label: "Claude usage limit hit (UC-16)", icon: <PauseCircle aria-hidden /> },
  { kind: "codex-limit", label: "ChatGPT usage limit hit (UC-16)", icon: <PauseCircle aria-hidden /> },
  { kind: "limits-reset", label: "Usage limits reset", icon: <PlayCircle aria-hidden /> },
  { kind: "chrome-toggle", label: "Close / reopen Chrome (needs_browser)", icon: <Globe aria-hidden /> },
  "sep",
  { kind: "login-expired", label: "LinkedIn login expired (UC-17)", icon: <KeyRound aria-hidden /> },
  { kind: "captcha", label: "TopCV shows a CAPTCHA (UC-17)", icon: <ShieldQuestion aria-hidden /> },
  { kind: "figma", label: "Figma bridge not running (UC-17)", icon: <Frame aria-hidden /> },
  { kind: "domain-confirm", label: "Apply leaves the job site (UC-11 e)", icon: <ExternalLink aria-hidden /> },
];

/**
 * Mock mode only: a "Sample data" badge and the prototype's Simulate menu, which plays events
 * the engine and the bridges would send (the real app has neither).
 */
export function MockMenu() {
  const api = useApi();
  if (api.mode !== "mock") return null;
  const run = (kind: SimulationKind) => void (api as LazyMockApi).ready.then((mock) => mock.simulate(kind));
  return (
    <div className="flex items-center gap-2">
      <Tooltip content="The orchestrator is not running, so this is sample data from a built-in mock. Start it with `pnpm dev`.">
        <Badge tone="warn" tabIndex={0} data-testid="mock-badge" aria-label="Sample data">
          {/* PM3 S7: at phone width the badge is a dot, so the page title keeps its room. */}
          <span aria-hidden className="size-1.5 rounded-full bg-current sm:hidden" />
          <span className="hidden sm:inline">Sample data</span>
        </Badge>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="warn" size="sm" rightIcon={<ChevronDown aria-hidden className="size-3.5" />} data-testid="simulate-menu" aria-label="Simulate">
            <span className="hidden sm:inline">Simulate</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-72">
          <DropdownMenuLabel>Mock events</DropdownMenuLabel>
          {ITEMS.map((item, i) =>
            item === "sep" ? (
              <DropdownMenuSeparator key={`sep-${i}`} />
            ) : (
              <DropdownMenuItem key={item.kind} icon={item.icon} onSelect={() => run(item.kind)}>
                {item.label}
              </DropdownMenuItem>
            ),
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
