"use client";

// The CV guidance screen (/guidance, design screens/guidance.md): which rules the CVs follow, where
// each came from, and where sources disagree. Ba's one control is Turn off / Turn on per rule
// (§5.9); the rules themselves are researched and refreshed by the system once per job-scan run.
import type { GuidanceRuleView, GuidanceView } from "@bs-job-agents/shared";
import { BookOpenCheck, RefreshCw, WifiOff } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button, EmptyState, Skeleton, buttonClass, useToast } from "@/components/ui";
import { errorMessage } from "@/lib/api/errors";
import { useLiveResource } from "@/lib/api/live-resource";
import { useGuidanceData, type GuidanceData } from "./data";
import { GuidanceRefreshBanner, GuidanceRuleCard } from "./GuidanceRule";
import { partialLine, summaryLine } from "./model";

export function GuidanceLive() {
  const data = useGuidanceData();
  const read = useLiveResource("guidance", () => data.view(), {
    refreshOn: (e) => e.type === "guidance.refresh" || e.type === "guidance.rule_added" || e.type === "guidance.rule_changed",
  });
  if (read.data !== undefined) return <GuidanceScreen initial={read.data} data={data} />;
  if (read.error && !read.loading) {
    return (
      <EmptyState
        icon={<WifiOff aria-hidden />}
        title="Could not load the CV guidance"
        description={<span data-testid="guidance-error">The orchestrator did not answer, so no rules are shown. Tailoring is not affected.</span>}
        action={
          <Button pill onClick={() => void read.reload()} leftIcon={<RefreshCw aria-hidden className="size-4" />}>
            Retry
          </Button>
        }
      />
    );
  }
  return (
    <div className="space-y-3" aria-busy aria-label="Loading the CV guidance" data-testid="guidance-loading">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="min-h-24 w-full" />
      ))}
    </div>
  );
}

export interface GuidanceScreenProps {
  initial: GuidanceView;
  data: GuidanceData;
}

export function GuidanceScreen({ initial, data }: GuidanceScreenProps) {
  const [view, setView] = useState(initial);
  const [seen, setSeen] = useState(initial);
  if (seen !== initial) {
    setSeen(initial);
    setView(initial);
  }
  const [busy, setBusy] = useState<string | null>(null);
  const { toast } = useToast();

  const toggle = async (rule: GuidanceRuleView) => {
    setBusy(rule.ruleId);
    try {
      setView(await data.setOff(rule.ruleId, !rule.turnedOff));
      toast({ title: rule.turnedOff ? "Turned on for your CVs." : "Turned off for your CVs. A refresh never turns it back on.", tone: "ok" });
    } catch (err) {
      toast({ title: errorMessage(err), tone: "err" });
    } finally {
      setBusy(null);
    }
  };

  if (view.rules.length === 0) {
    return (
      <EmptyState
        icon={<BookOpenCheck aria-hidden />}
        title="No guidance rules yet"
        description="The rule set is researched from recruiter sources when a job scan reaches its first tailor task."
        action={
          <Link href="/chat" className={buttonClass({ pill: true })}>
            Open Lead to start a scan
          </Link>
        }
      />
    );
  }

  const failed = view.lastRefresh?.outcome === "failed";
  const partial = partialLine(view);
  return (
    <div className="mx-auto max-w-[68ch] space-y-4" data-testid="guidance-screen">
      <header className="space-y-1">
        <h1 className="font-display text-xl font-semibold">CV guidance</h1>
        <p className="text-sm text-muted" data-testid="guidance-summary">
          {summaryLine(view)}{" "}
          <Link href="/activity" className="text-accent hover:underline">
            See what changed
          </Link>
        </p>
      </header>
      {failed ? <GuidanceRefreshBanner reason={view.lastRefresh?.error ?? "no source could be read"} lastSuccess={view.lastSuccessAt} /> : null}
      {partial ? (
        <p role="status" className="text-xs text-muted" data-testid="guidance-partial">
          {partial}
        </p>
      ) : null}
      <div className="space-y-3">
        {view.rules.map((rule) => (
          <GuidanceRuleCard key={rule.ruleId} rule={rule} busy={busy === rule.ruleId} onToggle={(r) => void toggle(r)} />
        ))}
      </div>
    </div>
  );
}
