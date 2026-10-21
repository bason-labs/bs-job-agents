"use client";

import type { TailoredCv } from "@bs-job-agents/shared";
import { FileText } from "lucide-react";
import { useApi } from "@/lib/api/react";
import { useFileViewer } from "@/components/ui/FileViewer";
import { cvName, type CvOption } from "./model";

/**
 * The preview's header, as the PDF prints it: the full name, the headline, then one contact line.
 * The name comes from the master CV (the card's candidateName): the tailored CV has none, and its
 * contactLine is the contact details (live 2026-10-20: the contact line was shown as the name). A
 * contact line that starts with the name (older fixtures) is not repeated.
 */
export function previewHeader(cv: Pick<TailoredCv, "headline" | "contactLine">, candidateName: string | null | undefined): { name: string | null; headline: string; contact: string } {
  const name = candidateName?.trim() || null;
  const parts = cv.contactLine.split(/\s*[·|]\s*/);
  const startsWithName = name !== null && parts[0]?.toLowerCase() === name.toLowerCase();
  const contact = startsWithName ? cv.contactLine.slice(cv.contactLine.indexOf(parts[1] ?? "")).trim() : cv.contactLine;
  return { name, headline: cv.headline, contact };
}

/** The tailored CV as a page thumbnail, with each bullet's [fact ids] for the truth check (prototype). */
function Page({ cv, candidateName }: { cv: TailoredCv; candidateName: string | null | undefined }) {
  const head = previewHeader(cv, candidateName);
  return (
    <div className="space-y-1 text-[7px] leading-tight text-slate-800">
      {head.name ? (
        <p className="text-[13px] font-bold" data-testid="cv-preview-name">
          {head.name.toUpperCase()}
        </p>
      ) : null}
      <p className="text-[7px] font-bold text-teal-700">{head.headline.toUpperCase()}</p>
      <p className="text-slate-500">{head.contact}</p>
      <hr className="my-1.5 border-slate-300" />
      {cv.summary ? (
        <p>
          {cv.summary.text} <span className="text-slate-400">[{cv.summary.factIds.join(", ")}]</span>
        </p>
      ) : null}
      {cv.sections.map((s) => (
        <div key={s.title}>
          <p className="mt-1 font-bold text-teal-700">{s.title.toUpperCase()}</p>
          {s.items.map((item, i) => (
            <div key={i}>
              {item.heading ? <p className="font-bold">{item.heading}</p> : null}
              {item.bullets.map((b, j) => (
                <p key={j}>
                  • {b.text} <span className="text-slate-400">[{b.factIds.join(", ")}]</span>
                </p>
              ))}
            </div>
          ))}
        </div>
      ))}
      <p className="mt-6 text-center text-slate-400">— tailored CV preview · [fact ids] shown for truth check —</p>
    </div>
  );
}

/** CV thumbnail + file name; both open the PDF in the in-app viewer (Download is inside, §11). */
export function CvPreview({ option, company, candidateName }: { option: CvOption; company: string; candidateName?: string | null }) {
  const api = useApi();
  const { openFile } = useFileViewer();
  const name = cvName(option);
  const open = option.pdf
    ? () =>
        openFile({
          name,
          kind: "pdf",
          url: api.fileUrl(option.pdf!.id),
          downloadUrl: api.fileUrl(option.pdf!.id, { download: true }),
          figmaUrl: option.cvVersion.figmaFrameUrl ?? undefined,
        })
    : undefined;
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={open}
        disabled={!open}
        title={open ? `Open ${name}` : "The PDF is not exported yet"}
        aria-label={`Open the ${company} CV (${option.cvVersion.language.toUpperCase()})`}
        data-testid="cv-preview"
        className="block h-[300px] w-full overflow-hidden rounded-xl border border-border bg-white p-3 text-left transition hover:ring-2 hover:ring-accent disabled:hover:ring-0"
      >
        <Page cv={option.cvVersion.tailored} candidateName={candidateName} />
      </button>
      <button
        type="button"
        onClick={open}
        disabled={!open}
        className="inline-flex max-w-full items-center gap-1 text-[11px] text-accent underline disabled:text-muted disabled:no-underline"
      >
        <FileText aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{name}</span>
      </button>
    </div>
  );
}
