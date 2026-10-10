"use client";

import { SKIP_REASONS, SKIP_REASON_LABELS, type ReviewCard, type SkipReason } from "@bs-job-agents/shared";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Dialog, DialogContent } from "@/components/ui/Dialog";
import { Input, Textarea } from "@/components/ui/Input";
import { applyDomain, approveLabel, needsReapproval } from "./model";

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  card: ReviewCard;
  pending: boolean;
}

/** UC-08 confirmation, prototype copy; approval covers the consent box (UC-08 step 3). */
export function ApproveDialog({
  open,
  onOpenChange,
  card,
  pending,
  fileName,
  introEdited,
  dryRunAvailable,
  onConfirm,
}: DialogProps & { fileName: string; introEdited: boolean; dryRunAvailable: boolean; onConfirm: (dryRun: boolean) => void }) {
  const [dryRun, setDryRun] = useState(false);
  const company = card.job.company;
  const domain = applyDomain(card.job);
  const label = approveLabel(card);
  const noLink = card.flags.noApplyLink || !domain;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={noLink ? `Approve ${company} (PDF only)?` : needsReapproval(card) ? `Approve again & submit to ${company}?` : `Approve & submit to ${company}?`}
        data-testid="approve-dialog"
        footer={
          <>
            <Button pill onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button pill variant="primary" loading={pending} onClick={() => onConfirm(dryRun)}>
              {dryRun ? "Approve dry run" : label}
            </Button>
          </>
        }
      >
        <ul className="list-disc space-y-1.5 pl-4 text-xs text-muted">
          {noLink ? (
            <>
              <li>There&apos;s no apply link for this job, so nothing is sent.</li>
              <li>
                The approved CV <b className="text-fg">{fileName}</b> is kept for you to send yourself.
              </li>
            </>
          ) : (
            <>
              <li>
                Apply fills the form <b className="text-fg">in your Chrome</b> (your existing login), on <b className="text-fg">{domain}</b> only.
              </li>
              <li>
                Uploads <b className="text-fg">{fileName}</b>.
              </li>
              <li>
                This approval also lets Apply <b className="text-fg">tick the employer&apos;s personal-data consent box</b> for this application.
              </li>
              <li>If the form asks something I don&apos;t know, I&apos;ll pause and ask you.</li>
              <li>{introEdited ? "Your intro text is used as written." : "Apply writes the intro from your master CV."}</li>
            </>
          )}
        </ul>
        {dryRunAvailable && !noLink ? (
          <Checkbox
            checked={dryRun}
            onCheckedChange={setDryRun}
            label="Dry run"
            description="Fill the form and take the screenshots, but never click submit (§12 dry-run acceptance)."
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** UC-09: Ba's note becomes CV's fix list for a new QA round. */
export function RequestChangesDialog({ open, onOpenChange, card, pending, onConfirm }: DialogProps & { onConfirm: (comment: string) => void }) {
  const [comment, setComment] = useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={`Request changes — ${card.job.company}`}
        data-testid="changes-dialog"
        footer={
          <>
            <Button pill onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button pill variant="primary" loading={pending} disabled={!comment.trim()} onClick={() => onConfirm(comment.trim())}>
              Send to CV
            </Button>
          </>
        }
      >
        <Textarea
          aria-label="What should change?"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="e.g. Lead with Next.js; drop the education portal project"
          autoFocus
        />
        <p className="text-xs text-muted">Goes to @CV → new round → QA re-scores → back to your queue.</p>
      </DialogContent>
    </Dialog>
  );
}

/** UC-10: skip with a reason (Other needs a note). */
export function SkipDialog({ open, onOpenChange, card, pending, onConfirm }: DialogProps & { onConfirm: (reason: SkipReason, note: string | null) => void }) {
  const [reason, setReason] = useState<SkipReason>("salary_low");
  const [note, setNote] = useState("");
  const needsNote = reason === "other" && !note.trim();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={`Skip ${card.job.company} — why?`}
        data-testid="skip-dialog"
        footer={
          <>
            <Button pill onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button pill variant="primary" loading={pending} disabled={needsNote} onClick={() => onConfirm(reason, note.trim() || null)}>
              Skip job
            </Button>
          </>
        }
      >
        <div role="radiogroup" aria-label="Reason" className="grid grid-cols-2 gap-2 text-xs">
          {SKIP_REASONS.map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={reason === r}
              onClick={() => setReason(r)}
              className={cn("rounded-xl px-3 py-2 text-left transition", reason === r ? "bg-gradient-brand text-white" : "border border-border hover:border-accent")}
            >
              {SKIP_REASON_LABELS[r]}
            </button>
          ))}
        </div>
        <Input
          aria-label="Note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={reason === "other" ? "Tell us why (needed for Other)" : "Optional note"}
          invalid={needsNote && note.length > 0}
        />
        <p className="text-xs text-muted">Reasons teach the insights bot (later phase) what you don&apos;t want.</p>
      </DialogContent>
    </Dialog>
  );
}

/** UC-07 b: Ba checks a flagged posting and confirms it, which enables Apply for this job. */
export function ConfirmInjectionDialog({ open, onOpenChange, card, pending, onConfirm }: DialogProps & { onConfirm: () => void }) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      tone="brand"
      loading={pending}
      title={`Is the ${card.job.company} posting safe?`}
      description={
        <span className="space-y-2">
          <span className="block">
            QA found text in this job post that tries to instruct the bots. Check the posting yourself; confirming enables Apply for this job only.
          </span>
          {card.job.url ? (
            <a href={card.job.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent underline">
              Open the posting <ExternalLink aria-hidden className="size-3" />
            </a>
          ) : null}
        </span>
      }
      confirmLabel="It's safe — enable Apply"
      onConfirm={onConfirm}
    />
  );
}
