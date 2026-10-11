"use client";

import type { WorkflowProposal } from "@bs-job-agents/shared";
import { Workflow } from "lucide-react";
import { useState } from "react";
import { errorText } from "@/components/schedules/apiError";
import { formatDateTime } from "@/components/schedules/datetime";
import { Badge, Button, Skeleton, useToast } from "@/components/ui";
import { useLiveResource } from "@/lib/api/live-resource";
import type { BotsData } from "./data";

/** "job-scan · workModes: remote · maxJobs: 5", or "custom definition". */
export function proposalSummary(p: Pick<WorkflowProposal, "basedOn" | "params">): string {
  if (!p.basedOn) return "custom definition (YAML)";
  const params = p.params ?? {};
  const flat = Object.entries((params.overrides as Record<string, unknown> | undefined) ?? params).map(
    ([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)}`,
  );
  return [`preset of ${p.basedOn}`, ...flat].join(" · ");
}

const STATUS_TONE = { pending: "warn", approved: "ok", dismissed: "neutral" } as const;

/**
 * Rule 3 (PM S22): Lead may only propose a workflow. Ba approves (it is saved as a workflow version,
 * and nothing starts) or dismisses it. Lives under Bots, next to the bot that proposed it.
 */
export function WorkflowProposals({ data }: { data: BotsData }) {
  const res = useLiveResource("w3c:proposals", () => data.proposals(), {
    refreshOn: (e) => e.type === "message.created" && e.message.author.type === "bot" && e.message.author.bot === "lead",
  });
  const [busy, setBusy] = useState<string | null>(null);
  const { toast } = useToast();
  const proposals = res.data ?? [];
  const pending = proposals.filter((p) => p.status === "pending");
  const decided = proposals.filter((p) => p.status !== "pending");

  const decide = async (p: WorkflowProposal, action: "approve" | "dismiss") => {
    setBusy(p.id);
    try {
      if (action === "approve") {
        const { workflow } = await data.approveProposal(p.id);
        toast({ title: `Saved ${workflow.name} v${workflow.version}. Nothing was started; ask Lead to run it.` });
      } else {
        await data.dismissProposal(p.id);
        toast({ title: `Dismissed ${p.name}` });
      }
      await res.reload();
    } catch (e) {
      toast({ title: `Couldn't ${action} ${p.name}: ${errorText(e)}`, tone: "err" });
      void res.reload();
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="proposals-title" data-testid="workflow-proposals" className="mt-6 space-y-3 rounded-3xl border border-border bg-surface/60 p-4">
      <div className="flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-2xl bg-surface-2 text-accent">
          <Workflow aria-hidden className="size-4" />
        </div>
        <div>
          <h2 id="proposals-title" className="font-display font-semibold">
            Workflow proposals {pending.length ? <Badge tone="warn" className="ml-1 px-1.5 text-[10px]">{pending.length}</Badge> : null}
          </h2>
          <p className="text-xs text-muted">Lead suggests a workflow when you keep asking for the same thing. Approving saves it as a new workflow version; it never starts a run.</p>
        </div>
      </div>

      {res.data === undefined ? (
        res.error ? (
          <p className="text-xs text-danger">Couldn&apos;t load the proposals: {errorText(res.error)}</p>
        ) : (
          <Skeleton className="h-16 w-full" />
        )
      ) : proposals.length === 0 ? (
        <p className="text-xs text-muted italic">No proposals. Lead only suggests; nothing here runs on its own.</p>
      ) : (
        <ul className="space-y-2">
          {[...pending, ...decided].map((p) => (
            <li key={p.id} data-testid="workflow-proposal" data-status={p.status} className="space-y-2 rounded-2xl border border-border bg-surface-2/40 p-3 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-[13px] font-medium">{p.name}</span>
                <span className="flex items-center gap-2 text-muted">
                  {formatDateTime(p.proposedAt)}
                  <Badge tone={STATUS_TONE[p.status]} className="px-1.5 text-[10px]">
                    {p.status === "approved" && p.savedVersion ? `saved v${p.savedVersion}` : p.status}
                  </Badge>
                </span>
              </div>
              <p>{p.description}</p>
              <p data-testid="workflow-proposal-summary" className="text-[11px] text-muted">
                {proposalSummary(p)}
              </p>
              {p.definitionYaml ? (
                <details>
                  <summary className="cursor-pointer text-[11px] text-accent">Show the definition</summary>
                  <pre className="mt-1 max-h-60 overflow-auto rounded-xl bg-surface p-2 text-[11px]">{p.definitionYaml}</pre>
                </details>
              ) : null}
              {p.status === "pending" ? (
                <div className="flex gap-2">
                  <Button size="sm" pill variant="primary" loading={busy === p.id} disabled={busy !== null} onClick={() => void decide(p, "approve")}>
                    Approve (save only)
                  </Button>
                  <Button size="sm" pill variant="ghost" disabled={busy !== null} onClick={() => void decide(p, "dismiss")}>
                    Dismiss
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
