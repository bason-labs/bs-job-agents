"use client";

import type { ApplicationDetail } from "@bs-job-agents/shared";
import * as RadixDialog from "@radix-ui/react-dialog";
import { CheckCircle2, ClipboardList, FileText, Image as ImageIcon, Pin, X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { Button, Skeleton, StatusPill, useFileViewer } from "@/components/ui";
import { cn } from "@/lib/cn";
import { statusMeta } from "@/lib/status";
import { formatDateTime } from "@/components/schedules/datetime";
import { approvalLine, fieldSourceLabel, fieldValueText, jdSnapshotNote, recordFiles, recordKicker, sourceLabel, type ApplicationRow } from "./logic";
import { cvViewerFile, formViewerFile, jdViewerFile, screenshotViewerFile, type FileUrl } from "./viewerFiles";

export interface RecordPanelProps {
  /** The row that was clicked (header shows at once); null = closed. */
  row: ApplicationRow | null;
  /** The full record, once loaded. */
  detail: ApplicationDetail | null;
  fileUrl: FileUrl;
  onClose: () => void;
  /** Failed applications only (UC-14 a, §10.2 rule 5: "apply again" override). */
  onApplyAgain: (row: ApplicationRow) => void;
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2" aria-label={title}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function ProofTile({
  icon,
  title,
  note,
  onOpen,
  className,
}: {
  icon: ReactNode;
  title: string;
  note: string;
  onOpen: (() => void) | null;
  className?: string;
}) {
  return (
    <button
      type="button"
      disabled={!onOpen}
      onClick={onOpen ?? undefined}
      className={cn(
        "flex items-start gap-2 rounded-xl border border-border p-3 text-left text-xs transition enabled:hover:border-accent disabled:opacity-50",
        className,
      )}
    >
      <span className="mt-0.5 shrink-0 text-accent [&_svg]:size-4">{icon}</span>
      <span className="min-w-0">
        <span className="block font-medium text-fg">{title}</span>
        <span className="block text-muted">{note}</span>
      </span>
    </button>
  );
}

/**
 * Submission record side panel (UC-13, §9.1): exactly what was sent. Every file opens in
 * the viewer first; Download lives inside the viewer. Never shows the approval token.
 */
export function RecordPanel({ row, detail, fileUrl, onClose, onApplyAgain }: RecordPanelProps) {
  const { openFile } = useFileViewer();
  const app = detail?.application ?? row?.application;
  const job = detail?.job ?? row?.job;
  const submission = detail?.submission ?? null;
  // PM3 S3: the record's own approval, else Ba's latest approval (shown before a record exists).
  const approval = submission?.approval ?? detail?.approval ?? null;
  const files = detail ? recordFiles(detail) : null;
  const company = job?.company ?? "";
  // The row that opened the panel; it keeps focus after the panel closes (row is null by then).
  const openerId = useRef<string | null>(null);
  useEffect(() => {
    if (row) openerId.current = row.application.id;
  }, [row]);

  return (
    <RadixDialog.Root open={row !== null} onOpenChange={(open) => !open && onClose()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <RadixDialog.Content
          data-testid="record-panel"
          aria-describedby={undefined}
          // Opened from a row, not a Dialog.Trigger: hand focus back to that row's button.
          onCloseAutoFocus={(e) => {
            const id = openerId.current;
            if (!id) return;
            e.preventDefault();
            document.querySelector<HTMLElement>(`[data-record-opener="${CSS.escape(id)}"]`)?.focus();
          }}
          className="fixed inset-y-0 right-0 z-40 w-[480px] max-w-full overflow-y-auto border-l border-border bg-surface shadow-2xl outline-none"
        >
          {app && job ? (
            <div className="space-y-5 p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-0.5">
                  <p className={cn("text-[10px] tracking-wider uppercase", app.origin === "imported" || app.dryRun ? "text-warn" : "text-muted")}>
                    {recordKicker(app)}
                  </p>
                  <RadixDialog.Title className="font-display text-lg font-semibold">{company}</RadixDialog.Title>
                  <p className="text-xs text-muted">
                    {job.title} · {sourceLabel(job.source)}
                    {app.submittedAt ? <span className="whitespace-nowrap"> · submitted {formatDateTime(app.submittedAt)}</span> : null}
                  </p>
                  {job.url ? (
                    <a href={job.url} target="_blank" rel="noopener noreferrer" className="block text-xs break-all text-accent underline">
                      {job.url}
                    </a>
                  ) : null}
                </div>
                <RadixDialog.Close aria-label="Close" title="Close" className="grid size-8 shrink-0 place-items-center rounded-xl text-muted hover:bg-surface-2 hover:text-fg">
                  <X aria-hidden className="size-4" />
                </RadixDialog.Close>
              </div>

              {app.status === "needs_check" ? (
                <p data-testid="record-callout" className="rounded-xl border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
                  {app.dryRun
                    ? "Dry run: Apply filled the form and took the screenshots but never clicked submit. Nothing was sent; mark it Failed to close it."
                    : "Apply couldn't confirm this submission. Check the employer's site, then set the status to Submitted if it went through, or Failed if not."}
                </p>
              ) : null}
              {app.status === "failed" ? (
                <div data-testid="record-callout" className="space-y-2 rounded-xl border border-danger/40 bg-danger/5 px-3 py-2 text-xs text-danger">
                  <p>Apply stopped: {app.statusHistory.at(-1)?.note ?? "the application failed"}. Nothing was submitted.</p>
                  {row ? (
                    <Button size="sm" pill onClick={() => onApplyAgain(row)}>
                      Apply again…
                    </Button>
                  ) : null}
                </div>
              ) : null}

              {!detail ? (
                <div data-testid="record-loading" className="space-y-3">
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-40 w-full" />
                </div>
              ) : !submission ? (
                <>
                  <p className="rounded-xl border border-dashed border-border p-4 text-center text-xs text-muted">
                    {app.status === "approved" || app.status === "paused"
                      ? "Not sent yet — Apply hasn't submitted this application."
                      : "No submission record — nothing was sent to the employer."}
                  </p>
                  {/* PM3 S3, UC-13: what Ba approved, before any record exists. */}
                  {approval ? (
                    <Section title="Approval">
                      <p data-testid="record-approval" className="text-xs text-muted">
                        {approvalLine(approval, detail.cvVersion?.label ?? null)}
                      </p>
                    </Section>
                  ) : null}
                </>
              ) : (
                <>
                  <Section title="CV file sent">
                    <div className="rounded-xl border border-border bg-surface-2/40 p-3">
                      {files?.cv ? (
                        <button
                          type="button"
                          onClick={() => openFile(cvViewerFile(files.cv!, fileUrl, detail.cvVersion?.figmaFrameUrl))}
                          className="flex items-center gap-2 text-left text-xs break-all text-accent underline"
                        >
                          <FileText aria-hidden className="size-4 shrink-0" />
                          {submission.uploadedFile?.filename ?? files.cv.filename}
                        </button>
                      ) : (
                        <p className="text-xs text-muted italic">{submission.uploadedFile?.filename ?? "not captured"}</p>
                      )}
                    </div>
                    <p data-testid="record-sha" className="font-mono text-[11px] break-all text-muted">
                      SHA-256: {submission.uploadedFile?.sha256 ?? "not captured"}
                    </p>
                  </Section>

                  <Section
                    title="Form fields"
                    action={
                      submission.fields.length ? (
                        <button type="button" onClick={() => openFile(formViewerFile(detail, submission))} className="text-[11px] text-accent hover:underline">
                          View as form
                        </button>
                      ) : null
                    }
                  >
                    <dl data-testid="record-fields" className="divide-y divide-border/60 rounded-xl border border-border">
                      {submission.fields.map((f) => (
                        <div key={`${f.label}-${f.name ?? ""}`} className="flex items-start justify-between gap-3 px-3 py-2 text-xs">
                          <dt className="shrink-0 text-muted">{f.label}</dt>
                          <dd className="text-right">
                            <span className="block">{fieldValueText(f)}</span>
                            <span className="text-[10px] text-accent">{fieldSourceLabel(f.source)}</span>
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </Section>

                  <Section title="Intro / cover text">
                    <p className={cn("rounded-xl border border-border bg-surface-2/40 p-3 text-xs leading-relaxed", !submission.introText && "text-muted italic")}>
                      {submission.introText ?? "not captured"}
                    </p>
                  </Section>

                  <Section title="Consent">
                    {submission.consent ? (
                      <p className="flex gap-2 text-xs">
                        <span className={submission.consent.ticked ? "text-ok" : "text-muted"}>{submission.consent.ticked ? "✓" : "—"}</span>
                        <span>{submission.consent.text ?? (submission.consent.ticked ? "ticked" : "not ticked")}</span>
                      </p>
                    ) : (
                      <p className="text-xs text-muted italic">not captured</p>
                    )}
                  </Section>

                  <Section title="Proof">
                    <div className="grid grid-cols-2 gap-2">
                      <ProofTile
                        icon={<ImageIcon aria-hidden />}
                        title="Before submit"
                        note={files?.preSubmit ? "filled form" : "not captured"}
                        onOpen={files?.preSubmit ? () => openFile(screenshotViewerFile(files.preSubmit!, fileUrl, company, "pre-submit screenshot")) : null}
                      />
                      <ProofTile
                        icon={<CheckCircle2 aria-hidden />}
                        title="Confirmation"
                        note={files?.confirmation ? (submission.confirmationText ?? "confirmation page") : "not captured"}
                        onOpen={files?.confirmation ? () => openFile(screenshotViewerFile(files.confirmation!, fileUrl, company, "confirmation screenshot")) : null}
                      />
                      <ProofTile
                        className={files?.jdScreenshot ? undefined : "col-span-2"}
                        icon={<Pin aria-hidden />}
                        title="JD snapshot"
                        note={jdSnapshotNote(submission, app.origin)}
                        onOpen={submission.jdSnapshot ? () => openFile(jdViewerFile(submission.jdSnapshot!, files?.jdText ?? null, fileUrl)) : null}
                      />
                      {files?.jdScreenshot ? (
                        <ProofTile
                          icon={<ClipboardList aria-hidden />}
                          title="JD page"
                          note="screenshot of the posting"
                          onOpen={() => openFile(screenshotViewerFile(files.jdScreenshot!, fileUrl, company, "JD page screenshot"))}
                        />
                      ) : null}
                    </div>
                  </Section>

                  <Section title="Approval">
                    <p data-testid="record-approval" className="text-xs text-muted">
                      {approval ? approvalLine(approval, detail.cvVersion?.label ?? null) : "not captured"}
                    </p>
                  </Section>
                </>
              )}

              {detail ? (
                <Section title="Status history">
                  <ol data-testid="record-history" className="space-y-1 text-xs">
                    {detail.application.statusHistory.map((h, i) => (
                      <li key={`${h.status}-${h.at}-${i}`} className="flex items-center justify-between gap-3 rounded-lg bg-surface-2/50 px-3 py-1.5">
                        <span className="min-w-0">
                          {statusMeta(h.status).label.toLowerCase()}
                          {h.note ? <span className="text-muted"> · {h.note}</span> : null}
                        </span>
                        <span className="shrink-0 text-muted">{formatDateTime(h.at)}</span>
                      </li>
                    ))}
                  </ol>
                </Section>
              ) : null}

              <div className="flex items-center justify-between gap-3">
                <p className="text-[11px] text-muted">
                  This record is frozen when the application is submitted — later CV edits or a deleted job post don&apos;t change it. Only the status can change.
                </p>
                <StatusPill status={app.status} className="shrink-0" />
              </div>
            </div>
          ) : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
