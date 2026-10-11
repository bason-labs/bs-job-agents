"use client";

import type { TailoredCv } from "@bs-job-agents/shared";
import { FileText } from "lucide-react";
import { useApi } from "@/lib/api/react";
import { useFileViewer } from "@/components/ui/FileViewer";
import { cvName, type CvOption } from "./model";

/** The tailored CV as a page thumbnail, with each bullet's [fact ids] for the truth check (prototype). */
function Page({ cv }: { cv: TailoredCv }) {
  const name = cv.contactLine.split("·")[0]?.trim() ?? "";
  return (
    <div className="space-y-1 text-[7px] leading-tight text-slate-800">
      <p className="text-[13px] font-bold">{name.toUpperCase()}</p>
      <p className="text-[7px] font-bold text-teal-700">{cv.headline.toUpperCase()}</p>
      <p className="text-slate-500">{cv.contactLine}</p>
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
export function CvPreview({ option, company }: { option: CvOption; company: string }) {
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
        <Page cv={option.cvVersion.tailored} />
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
