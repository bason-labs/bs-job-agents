"use client";

// API research (design 2026-10-19 §5.6): the Search criteria source toggles, each with how the
// board is read ("Public API", "Direct (no login)", "Account API", "Account API (needs approval)",
// "Account API (token missing)", "Browser"; shared ACCESS_LABELS). A high-risk board's account API
// waits for Ba's approval: Approve shows the record's terms quote and account risk first, and an
// approval can be revoked. Labels and actions come from GET /sources/access, read apart from the
// criteria so a failure there never blocks editing them.
import { ACCESS_LABELS, ACCESS_LABEL_HINTS, type SearchSource, type SourceAccessView } from "@bs-job-agents/shared";
import { ExternalLink } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { errorText } from "@/components/schedules/apiError";
import { Button, Dialog, DialogContent, useToast } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { CriteriaData } from "./data";
import { SOURCE_GROUP_OPTIONS } from "./logic";

type AccessRead = { status: "loading" } | { status: "ok"; views: Partial<Record<SearchSource, SourceAccessView>> } | { status: "error"; error: unknown };

/** Where the board's token goes (docs/runbook.md, "Board tokens"). */
export const TOKEN_HINT = "Add its token to the secrets file: see “Board tokens” in docs/runbook.md.";

export interface SourceTogglesProps {
  data: CriteriaData;
  values: readonly SearchSource[];
  onToggle: (source: SearchSource) => void;
  invalid?: boolean;
}

export function SourceToggles({ data, values, onToggle, invalid }: SourceTogglesProps) {
  const [read, setRead] = useState<AccessRead>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  // The dialog keeps its last board while it closes, so its content stays put and focus returns.
  const [confirming, setConfirming] = useState<SourceAccessView | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState<SearchSource | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    let live = true;
    data.sourceAccess().then(
      (list) => live && setRead({ status: "ok", views: Object.fromEntries(list.map((v) => [v.source, v])) }),
      (error: unknown) => live && setRead({ status: "error", error }),
    );
    return () => {
      live = false;
    };
  }, [data, attempt]);

  const retry = () => {
    setRead({ status: "loading" });
    setAttempt((n) => n + 1);
  };

  const put = (view: SourceAccessView) => setRead((r) => (r.status === "ok" ? { status: "ok", views: { ...r.views, [view.source]: view } } : r));

  const approve = async (view: SourceAccessView) => {
    setBusy(view.source);
    try {
      put(await data.approveSource(view.source, view.researchedAt ?? ""));
      setDialogOpen(false);
      toast({ title: `Approved the account API for ${nameOf(view.source)}` });
    } catch (e) {
      setDialogOpen(false);
      toast({ title: `Couldn't approve ${nameOf(view.source)}: ${errorText(e)}`, tone: "err" });
      retry();
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (view: SourceAccessView) => {
    setBusy(view.source);
    try {
      put(await data.revokeSource(view.source));
      toast({ title: `Revoked: ${nameOf(view.source)} is read in the browser again` });
    } catch (e) {
      toast({ title: `Couldn't revoke ${nameOf(view.source)}: ${errorText(e)}`, tone: "err" });
    } finally {
      setBusy(null);
    }
  };

  const views = read.status === "ok" ? read.views : {};
  return (
    <>
      {SOURCE_GROUP_OPTIONS.map((g) => (
        <div key={g.group} className="space-y-1.5" data-testid={`criteria-sources-${g.group}`}>
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted">{g.label}</p>
          <div role="group" aria-label={g.label} className="flex flex-wrap gap-x-4 gap-y-2.5">
            {g.options.map((o) => (
              <SourceToggle
                key={o.value}
                source={o.value}
                label={o.label}
                on={values.includes(o.value)}
                invalid={invalid}
                view={views[o.value]}
                busy={busy === o.value}
                onToggle={() => onToggle(o.value)}
                onApprove={(v) => {
                  setConfirming(v);
                  setDialogOpen(true);
                }}
                onRevoke={(v) => void revoke(v)}
              />
            ))}
          </div>
        </div>
      ))}
      {read.status === "error" ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="source-access-error">
          <p role="alert" className="text-xs text-danger">
            Couldn&apos;t load how each source is read: {errorText(read.error)}
          </p>
          <Button size="sm" pill variant="ghost" onClick={retry}>
            Retry
          </Button>
        </div>
      ) : null}
      <ApproveDialog
        open={dialogOpen}
        view={confirming}
        busy={confirming !== null && busy === confirming.source}
        onCancel={() => setDialogOpen(false)}
        onConfirm={(v) => void approve(v)}
      />
    </>
  );
}

const NAMES = Object.fromEntries(SOURCE_GROUP_OPTIONS.flatMap((g) => g.options.map((o) => [o.value, o.label]))) as Record<SearchSource, string>;
const nameOf = (s: SearchSource) => NAMES[s] ?? s;

interface SourceToggleProps {
  source: SearchSource;
  label: string;
  on: boolean;
  invalid?: boolean;
  /** Undefined while loading (no label, as before) or when the read failed. */
  view: SourceAccessView | undefined;
  busy: boolean;
  onToggle: () => void;
  onApprove: (view: SourceAccessView) => void;
  onRevoke: (view: SourceAccessView) => void;
}

function SourceToggle({ source, label, on, invalid, view, busy, onToggle, onApprove, onRevoke }: SourceToggleProps) {
  const pathId = useId();
  const hint = view ? ACCESS_LABEL_HINTS[view.labelKey] : undefined;
  const action = view?.needsApproval ? "approve" : view?.approvedAt ? "revoke" : null;
  return (
    <div className="flex min-w-36 flex-col items-start gap-1" data-testid={`source-${source}`}>
      <button
        type="button"
        aria-pressed={on}
        aria-describedby={view ? pathId : undefined}
        onClick={onToggle}
        className={cn(
          "rounded-full px-3 py-1 text-xs transition",
          on ? "bg-gradient-brand text-white shadow-glow" : "border text-muted hover:text-fg",
          !on && (invalid ? "border-danger" : "border-border hover:border-accent"),
        )}
      >
        {label}
      </button>
      {/* The label line keeps its height while loading so nothing jumps when it fills in. */}
      <p id={pathId} className="min-h-4 pl-1 text-[11px] leading-4 text-muted" data-testid="source-access-label">
        {view ? (
          <>
            <span className={cn(view.labelKey === "account_api_needs_approval" || view.labelKey === "account_api_token_missing" ? "text-warn" : undefined)}>
              {ACCESS_LABELS[view.labelKey]}
            </span>
            {hint ? <span> · {hint}</span> : null}
          </>
        ) : null}
      </p>
      {view?.tokenMissing ? (
        <p className="max-w-56 pl-1 text-[11px] leading-4 text-muted" data-testid="source-token-hint">
          {TOKEN_HINT}
        </p>
      ) : null}
      {view && action ? (
        // One button for both actions, so focus comes back to it when the dialog closes.
        <Button
          size="sm"
          pill
          variant={action === "approve" ? "secondary" : "ghost"}
          loading={busy && action === "revoke"}
          onClick={() => (action === "approve" ? onApprove(view) : onRevoke(view))}
          aria-label={`${action === "approve" ? "Approve" : "Revoke"} the account API for ${label}`}
          data-testid={`source-${action}`}
          className="h-7"
        >
          {action === "approve" ? "Approve…" : "Revoke"}
        </Button>
      ) : null}
    </div>
  );
}

interface ApproveDialogProps {
  open: boolean;
  view: SourceAccessView | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (view: SourceAccessView) => void;
}

/** Ba reads the board's terms and the account risk before its account API is used. */
function ApproveDialog({ open, view, busy, onCancel, onConfirm }: ApproveDialogProps) {
  const name = view ? nameOf(view.source) : "";
  return (
    <Dialog open={open && view !== null} onOpenChange={(open) => (open ? undefined : onCancel())}>
      {view ? (
        <DialogContent
          size="lg"
          hideClose
          data-testid="source-approve-dialog"
          title={`Approve the account API for ${name}?`}
          description={`${name} is read in the browser until you approve. Once approved, scans read its own web API with your account token.`}
          footer={
            <>
              <Button pill onClick={onCancel}>
                Cancel
              </Button>
              <Button pill variant="primary" loading={busy} onClick={() => onConfirm(view)} data-testid="source-approve-confirm">
                Approve
              </Button>
            </>
          }
        >
          <section aria-label="Terms of use" className="space-y-2">
            <p className="text-xs font-medium">Terms of use</p>
            {view.termsOfUse?.url ? (
              <a href={view.termsOfUse.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs break-all text-accent hover:underline">
                {view.termsOfUse.url}
                <ExternalLink aria-hidden className="size-3 shrink-0" />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            ) : null}
            {view.termsOfUse?.clauses.length ? (
              <ul className="space-y-1.5">
                {view.termsOfUse.clauses.map((c, i) => (
                  <li key={i}>
                    <blockquote className="border-l-2 border-border pl-3 text-xs text-muted">“{c}”</blockquote>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted">No clauses recorded.</p>
            )}
          </section>
          <section aria-label="Account risk" className="space-y-1 rounded-xl border border-warn/40 bg-warn/10 p-3">
            <p className="text-xs font-medium text-warn">Account risk</p>
            <p className="text-xs">{view.accountRisk}</p>
          </section>
          <p className="text-[11px] text-muted">Researched {view.researchedAt}. If the research changes, the approval lapses and you approve again. You can revoke it at any time.</p>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
