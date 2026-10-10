"use client";

import type { ApplicationDetail, ApplicationStatus } from "@bs-job-agents/shared";
import { Briefcase, Download } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, Button, ConfirmDialog, EmptyState, useFileViewer, useToast } from "@/components/ui";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/components/schedules/datetime";
import { applicationsData, type ApplicationsData, type ApplicationsList } from "./data";
import { applicationsHeader, cvLabel, exportFileName, sourceLabel, type ApplicationRow } from "./logic";
import { RecordPanel } from "./RecordPanel";
import { StatusSelect } from "./StatusSelect";
import { cvViewerFile, screenshotViewerFile } from "./viewerFiles";
import { errorText } from "@/components/schedules/apiError";

export interface ApplicationsScreenProps {
  initial: ApplicationsList;
  /** Defaults to the app's data source; tests pass their own. */
  data?: ApplicationsData;
}

/** Starts a download of `href` (the export ZIP); the browser saves it as `name`. */
function download(href: string, name: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** UC-13 / UC-13b: every application, its status, the submission record panel and the ZIP export. */
export function ApplicationsScreen({ initial, data = applicationsData }: ApplicationsScreenProps) {
  const [rows, setRows] = useState(initial.applications);
  const [lastExportAt, setLastExportAt] = useState(initial.lastExportAt);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, ApplicationDetail>>({});
  const [exporting, setExporting] = useState(false);
  const [applyAgainRow, setApplyAgainRow] = useState<ApplicationRow | null>(null);
  const { toast } = useToast();
  const { openFile } = useFileViewer();
  const router = useRouter();

  const selected = rows.find((r) => r.application.id === selectedId) ?? null;

  const openRecord = async (row: ApplicationRow) => {
    const id = row.application.id;
    setSelectedId(id);
    if (details[id]) return;
    try {
      const detail = await data.get(id);
      if (detail) setDetails((d) => ({ ...d, [id]: detail }));
    } catch (e) {
      toast({ title: `Couldn't load the record: ${errorText(e)}`, tone: "err" });
    }
  };

  const changeStatus = async (row: ApplicationRow, status: ApplicationStatus) => {
    const id = row.application.id;
    try {
      const app = await data.changeStatus(id, { status, note: null });
      setRows((rs) => rs.map((r) => (r.application.id === id ? { ...r, application: app } : r)));
      setDetails((d) => (d[id] ? { ...d, [id]: { ...d[id]!, application: app } } : d));
    } catch (e) {
      toast({ title: `Couldn't change ${row.job.company}'s status: ${errorText(e)}`, tone: "err" });
    }
  };

  const exportAll = async () => {
    setExporting(true);
    try {
      const res = await data.exportAll();
      const name = exportFileName(res.export);
      download(res.downloadUrl, name);
      setLastExportAt(res.export.createdAt);
      toast({ title: `Exported ${res.export.applicationCount} applications → ${name}` });
    } catch (e) {
      toast({ title: `Export failed: ${errorText(e)}`, tone: "err" });
    } finally {
      setExporting(false);
    }
  };

  const applyAgain = async (row: ApplicationRow) => {
    setApplyAgainRow(null);
    try {
      await data.applyAgain(row.application.id);
      setSelectedId(null);
      toast({
        title: `${row.job.company} is back in your review queue. Approving it there starts a new application.`,
        action: { label: "Open review", onClick: () => router.push("/review") },
      });
    } catch (e) {
      toast({ title: `Couldn't apply again: ${errorText(e)}`, tone: "err" });
    }
  };

  const openCv = (row: ApplicationRow) => {
    const pdfId = row.cvVersion?.pdfFileId ?? row.cvFile?.id;
    const ref = row.cvFile ?? (pdfId ? { id: pdfId, kind: "cv_pdf" as const, filename: cvLabel(row), mime: "application/pdf" } : null);
    if (ref) openFile(cvViewerFile({ ...ref, filename: cvLabel(row) }, data.fileUrl, row.cvVersion?.figmaFrameUrl));
  };

  const openConfirmation = (row: ApplicationRow) => {
    const id = row.confirmationScreenshotFileId;
    if (id) openFile(screenshotViewerFile({ id, kind: "screenshot", filename: "confirmation.png", mime: "image/png" }, data.fileUrl, row.job.company, "confirmation screenshot"));
  };

  const hasImported = rows.some((r) => r.application.origin === "imported");
  const hasDryRun = rows.some((r) => r.application.dryRun);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p data-testid="applications-header" className="text-xs text-muted">
          {applicationsHeader(rows.length, lastExportAt)}
        </p>
        <Button variant="primary" size="sm" pill onClick={() => void exportAll()} loading={exporting} leftIcon={<Download aria-hidden className="size-4" />}>
          Export all (ZIP)
        </Button>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={<Briefcase aria-hidden />}
          title="No applications yet"
          description="Every submitted application is listed here with its CV version, screenshot and status. Click a row for the full submission record."
        />
      ) : (
        <div className="overflow-x-auto rounded-3xl border border-border bg-surface/60">
          <table className="w-full min-w-[800px] text-left text-xs">
            <thead className="bg-surface-2/60 text-[10px] tracking-wider text-muted uppercase">
              <tr>
                <th className="px-4 py-3 font-medium">Company</th>
                <th className="px-3 py-3 font-medium">Role</th>
                <th className="px-3 py-3 font-medium">Source</th>
                <th className="px-3 py-3 font-medium">CV version</th>
                <th className="px-3 py-3 font-medium">Submitted</th>
                <th className="px-3 py-3 font-medium">Status</th>
                <th className="px-3 py-3 font-medium">Proof</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {rows.map((row) => {
                const app = row.application;
                const hasCv = !!(row.cvVersion?.pdfFileId ?? row.cvFile);
                return (
                  <tr
                    key={app.id}
                    data-testid="application-row"
                    data-status={app.status}
                    data-clickable
                    title="Open submission record"
                    onClick={() => void openRecord(row)}
                    className={cn(
                      "transition hover:bg-surface-2/60",
                      app.status === "needs_check" && "bg-warn/5",
                      selectedId === app.id && "bg-surface-2",
                    )}
                  >
                    <td className="px-4 py-3">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void openRecord(row);
                          }}
                          aria-label={`Open ${row.job.company}'s submission record`}
                          data-record-opener={app.id}
                          className="text-left font-medium hover:underline"
                        >
                          {row.job.company}
                        </button>
                        {app.origin === "imported" ? <Badge className="px-1.5 text-[9px]">imported</Badge> : null}
                        {app.dryRun ? (
                          <Badge tone="warn" className="px-1.5 text-[9px]">
                            dry run
                          </Badge>
                        ) : null}
                      </span>
                    </td>
                    <td className="px-3 py-3">{row.job.title}</td>
                    <td className="px-3 py-3">{sourceLabel(row.job.source)}</td>
                    <td className="px-3 py-3">
                      {hasCv ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openCv(row);
                          }}
                          title={cvLabel(row)}
                          className="block max-w-[11rem] truncate text-left text-accent underline"
                        >
                          {cvLabel(row)}
                        </button>
                      ) : (
                        <span className="whitespace-nowrap text-muted italic">not captured</span>
                      )}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap text-muted">{formatDateTime(app.submittedAt)}</td>
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                      <StatusSelect app={app} company={row.job.company} onChange={(s) => void changeStatus(row, s)} />
                    </td>
                    <td className="px-3 py-3">
                      {row.confirmationScreenshotFileId ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openConfirmation(row);
                          }}
                          className="text-accent underline"
                        >
                          screenshot
                        </button>
                      ) : (
                        <span className="whitespace-nowrap text-muted italic">not captured</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {hasImported || hasDryRun ? (
        <p className="text-xs text-muted">
          {hasImported ? (
            <>
              <b>Imported</b> applications were made before this app, so their records are partial: missing parts show “not captured”. The dedupe step
              keeps them out of new scans.{" "}
            </>
          ) : null}
          {hasDryRun ? (
            <>
              A <b>dry run</b> fills the form and takes screenshots but never submits; it is left out of the export.
            </>
          ) : null}
        </p>
      ) : null}

      <RecordPanel
        row={selected}
        detail={selectedId ? (details[selectedId] ?? null) : null}
        fileUrl={data.fileUrl}
        onClose={() => setSelectedId(null)}
        onApplyAgain={(row) => setApplyAgainRow(row)}
      />

      <ConfirmDialog
        open={applyAgainRow !== null}
        onOpenChange={(open) => !open && setApplyAgainRow(null)}
        tone="brand"
        title={applyAgainRow ? `Apply to ${applyAgainRow.job.company} again?` : ""}
        description="The job goes back to your review queue with its last CV. Nothing is sent until you approve it there; this failed attempt stays in the list."
        confirmLabel="Send to review"
        onConfirm={() => applyAgainRow && void applyAgain(applyAgainRow)}
      />
    </div>
  );
}
