"use client";

import type { ReviewCard, SkipReason } from "@bs-job-agents/shared";
import { ArrowUpRight, CircleAlert, Info, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { useId, useState, type ReactNode } from "react";
import type { ApproveResult } from "@/lib/api/contract";
import { errorMessage } from "@/lib/api/errors";
import { useApi } from "@/lib/api/react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Textarea } from "@/components/ui/Input";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { useToast } from "@/components/ui/Toast";
import { CvPreview } from "./CvPreview";
import {
  approveErrorText,
  approveLabel,
  companySummary,
  cvName,
  escalationNote,
  flagNotices,
  gapText,
  hardFailText,
  introPayload,
  isBlockedByInjection,
  isDryRunSettled,
  needsReapproval,
  jobMeta,
  languageLabel,
  roundLabel,
  type CvOption,
  type NoticeTone,
} from "./model";
import { ApproveDialog, ConfirmInjectionDialog, RequestChangesDialog, SkipDialog } from "./ReviewDialogs";

/** What Ba did to a card while it waits for the bots (prototype status lines). */
export type ActedOutcome = { kind: "approved"; result: ApproveResult; dryRun: boolean } | { kind: "changes" };

const TONE: Record<NoticeTone, string> = {
  warn: "border-warn/40 bg-warn/10 text-warn",
  danger: "border-danger/40 bg-danger/5 text-danger",
  info: "border-accent/30 bg-accent/5 text-fg",
};
const ICON: Record<NoticeTone, ReactNode> = {
  warn: <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />,
  danger: <ShieldAlert aria-hidden className="mt-px size-3.5 shrink-0" />,
  info: <Info aria-hidden className="mt-px size-3.5 shrink-0 text-accent" />,
};

function Notice({ tone, children, testId }: { tone: NoticeTone; children: ReactNode; testId?: string }) {
  return (
    <div data-testid={testId} className={cn("flex items-start gap-2 rounded-xl border px-3 py-2 text-xs", TONE[tone])}>
      {ICON[tone]}
      <div className="min-w-0 flex-1 space-y-2">{children}</div>
    </div>
  );
}

function Box({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-surface-2/40 p-3">
      <p className="mb-1 text-[10px] tracking-wider text-muted uppercase">{title}</p>
      {children}
    </div>
  );
}

const CRITERIA = [
  ["JD match", "jdMatch", 40],
  ["Company tone", "companyTone", 20],
  ["Format/ATS", "formatAts", 20],
  ["Clarity", "clarity", 20],
] as const;

function QaBox({ option }: { option: CvOption }) {
  const last = option.qaRounds.at(-1);
  if (!last) return null;
  return (
    <div className="rounded-xl border border-border bg-surface-2/40 p-3" data-testid="qa-box">
      <div className="flex flex-wrap justify-between gap-2">
        <p className="text-[10px] tracking-wider text-muted uppercase">QA score</p>
        <p className="text-xs">
          <b className={last.passed ? "text-ok" : "text-warn"}>
            {last.total} · {last.passed ? "passed" : "not passed"}
          </b>{" "}
          <span className="text-muted">{roundLabel(option.cvVersion)}</span>
        </p>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        {CRITERIA.map(([label, key, max]) => {
          const s = last.scores[key];
          return (
            <div key={key} title={s.justification}>
              <span>{label}</span>{" "}
              <b className="tabular">
                {s.score}/{max}
              </b>
              <ProgressBar value={(s.score / max) * 100} size="xs" label={`${label} ${s.score} of ${max}`} className="mt-1" />
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-muted">{hardFailText(last)}</p>
      {option.qaRounds.length > 1 ? (
        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs" data-testid="qa-rounds">
          <span className="text-muted">Rounds:</span>
          {option.qaRounds.map((r, i) => (
            <span key={r.id} className={cn("rounded-md px-1.5 py-0.5 tabular", r.passed ? "bg-ok/10 text-ok" : "bg-danger/10 text-danger")}>
              R{i + 1} {r.total} {r.passed ? "✓" : "✗"}
            </span>
          ))}
        </p>
      ) : null}
    </div>
  );
}

type DialogKind = "approve" | "changes" | "skip" | "injection" | null;

export interface ReviewCardItemProps {
  card: ReviewCard;
  acted: ActedOutcome | null;
  onApproved: (card: ReviewCard, result: ApproveResult, dryRun: boolean) => void;
  onChangesRequested: (card: ReviewCard) => void;
  onSkipped: (card: ReviewCard, reason: SkipReason) => void;
  onInjectionConfirmed: () => void;
}

/** One review card (prototype): job, fit, company, QA, CV preview (VI/EN), intro, decisions. */
export function ReviewCardItem({ card, acted, onApproved, onChangesRequested, onSkipped, onInjectionConfirmed }: ReviewCardItemProps) {
  const api = useApi();
  const { toast } = useToast();
  const introId = useId();
  const [lang, setLang] = useState(card.defaultLanguage);
  const [intro, setIntro] = useState(card.introText ?? "");
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [pending, setPending] = useState(false);
  const option = card.cvOptions.find((o) => o.cvVersion.language === lang) ?? card.cvOptions[0]!;
  const blocked = isBlockedByInjection(card);
  const notices = flagNotices(card);
  const { job } = card;

  const act = async (work: () => Promise<void>, describe: (err: unknown) => string = errorMessage) => {
    setPending(true);
    try {
      await work();
      setDialog(null);
    } catch (err) {
      toast({ title: describe(err), tone: "err" });
    } finally {
      setPending(false);
    }
  };

  const approve = (dryRun: boolean) =>
    act(async () => {
      const result = await api.approve(job.id, { cvVersionId: option.cvVersion.id, introText: introPayload(intro), ...(dryRun ? { dryRun } : {}) });
      onApproved(card, result, dryRun);
    }, approveErrorText);

  return (
    <article
      data-testid="review-card"
      data-job={job.id}
      aria-label={`${job.title} — ${job.company}`}
      className={cn("grid gap-5 rounded-3xl border bg-surface/60 p-5 md:grid-cols-[minmax(0,1fr)_250px]", card.flags.qaPassed ? "border-border" : "border-warn/50")}
    >
      <div className="min-w-0 space-y-3">
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="font-display text-lg font-semibold">
              {job.title} — {job.company}
            </h2>
            <p className="text-xs text-muted">{jobMeta(job)}</p>
            {job.url ? (
              <a href={job.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-xs text-accent hover:underline">
                View the posting <ArrowUpRight aria-hidden className="size-3" />
              </a>
            ) : null}
          </div>
          <div className="shrink-0 text-right">
            <p className="text-[10px] text-muted uppercase">Fit</p>
            <p className="font-display text-2xl font-bold text-accent tabular" data-testid="fit">
              {job.fitScore ?? "—"}
            </p>
          </div>
        </header>

        {card.flags.escalated ? (
          <Notice tone="warn" testId="escalation">
            {escalationNote(option)}
          </Notice>
        ) : null}
        {notices.map((n) => (
          <Notice key={n.key} tone={n.tone} testId={`flag-${n.key}`}>
            <p>{n.text}</p>
            {n.key === "injection" && !acted ? (
              <Button size="sm" pill variant="secondary" onClick={() => setDialog("injection")}>
                I checked it — enable Apply
              </Button>
            ) : null}
            {n.key === "needsInput" && card.factRequests.length ? (
              <ul className="list-disc space-y-0.5 pl-4 text-fg">
                {card.factRequests.map((f) => (
                  <li key={f.topic}>
                    {f.question} <span className="text-muted">({f.reason})</span>{" "}
                    <Link href="/cv" className="text-accent underline">
                      Answer in Master CV
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
          </Notice>
        ))}

        <div className="grid gap-3 sm:grid-cols-2">
          <Box title="Why it fits / gaps">
            <ul className="list-disc space-y-0.5 pl-4 text-xs">
              {job.fitReasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
              {job.gaps.map((g) => (
                <li key={g}>{gapText(g)}</li>
              ))}
            </ul>
          </Box>
          <Box title="Company">
            <p className="text-xs" data-testid="company-summary">
              {companySummary(card.company)}
            </p>
            {card.company?.profile?.sources.length ? (
              <p className="mt-1 flex flex-wrap gap-x-2 text-[11px]">
                {card.company.profile.sources.map((s) => (
                  <a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                    {s.title}
                  </a>
                ))}
              </p>
            ) : null}
          </Box>
        </div>

        <QaBox option={option} />

        {acted ? (
          <p className="text-xs text-accent" role="status" data-testid="acted">
            {acted.kind === "changes" ? (
              "● CV is revising with your note → QA will re-score…"
            ) : acted.result.taskId === null ? (
              "✓ Approved — the PDF is ready; nothing was sent."
            ) : (
              <>
                ● {acted.dryRun ? "Dry run: Apply fills the form and stops before submit…" : "Apply is working in your Chrome…"}{" "}
                <Link href="/chat" className="underline">
                  see chat
                </Link>
              </>
            )}
          </p>
        ) : (
          <>
            <Field label="Intro / cover text (optional)" htmlFor={introId} hint="Leave it empty and Apply writes one from your master CV.">
              <Textarea id={introId} rows={2} value={intro} onChange={(e) => setIntro(e.target.value)} placeholder="e.g. I have 4+ years building React/Next.js products…" />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                pill
                disabled={blocked}
                title={blocked ? "Confirm the flagged posting first" : undefined}
                onClick={() => setDialog("approve")}
                className="px-5 font-medium"
              >
                {approveLabel(card)}
              </Button>
              {/* The CV is fixed once approved: a re-approval or a live run after a dry run keeps it (the engine refuses changes). */}
              {needsReapproval(card) || isDryRunSettled(card) ? null : (
                <Button pill className="px-5" onClick={() => setDialog("changes")}>
                  Request changes…
                </Button>
              )}
              <Button pill className="px-5 text-muted" onClick={() => setDialog("skip")}>
                Skip (give reason)
              </Button>
            </div>
          </>
        )}
      </div>

      <aside className="space-y-2">
        {card.cvOptions.length > 1 ? (
          <div role="radiogroup" aria-label="CV language" className="flex rounded-full border border-border p-0.5 text-xs">
            {card.cvOptions.map((o) => {
              const on = o.cvVersion.language === lang;
              return (
                <button
                  key={o.cvVersion.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setLang(o.cvVersion.language)}
                  className={cn("flex-1 rounded-full py-1 transition", on ? "bg-gradient-brand text-white" : "text-muted hover:text-fg")}
                >
                  {languageLabel(o.cvVersion.language)}
                </button>
              );
            })}
          </div>
        ) : null}
        <CvPreview option={option} company={job.company} />
      </aside>

      {dialog === "approve" ? (
        <ApproveDialog
          open
          onOpenChange={(o) => !o && setDialog(null)}
          card={card}
          pending={pending}
          fileName={cvName(option)}
          introEdited={introPayload(intro) !== null}
          dryRunAvailable={!isDryRunSettled(card)}
          onConfirm={(dryRun) => void approve(dryRun)}
        />
      ) : null}
      {dialog === "changes" ? (
        <RequestChangesDialog
          open
          onOpenChange={(o) => !o && setDialog(null)}
          card={card}
          pending={pending}
          onConfirm={(comment) =>
            void act(async () => {
              await api.requestChanges(job.id, { comment });
              onChangesRequested(card);
            })
          }
        />
      ) : null}
      {dialog === "skip" ? (
        <SkipDialog
          open
          onOpenChange={(o) => !o && setDialog(null)}
          card={card}
          pending={pending}
          onConfirm={(reason, note) =>
            void act(async () => {
              await api.skip(job.id, { reason, note });
              onSkipped(card, reason);
            })
          }
        />
      ) : null}
      {dialog === "injection" ? (
        <ConfirmInjectionDialog
          open
          onOpenChange={(o) => !o && setDialog(null)}
          card={card}
          pending={pending}
          onConfirm={() =>
            void act(async () => {
              await api.confirmInjection(job.id);
              onInjectionConfirmed();
            })
          }
        />
      ) : null}
    </article>
  );
}
