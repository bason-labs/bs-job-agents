// Phase 3 QA: the review card on the live orchestrator. The API serves confirm-injection (UC-07 b)
// and the shared flags (approveAgain, dryRunSettled), so the card offers only what the engine
// accepts: Request changes is refused (409) for a card that waits for a re-approval or for a live
// approval after a settled dry run.
import type { ReviewCard } from "@bs-job-agents/shared";
import { reviewCardFixture } from "@bs-job-agents/shared/fixtures";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { WebApi } from "@/lib/api/contract";
import { ApiProvider } from "@/lib/api/react";
import { FileViewerProvider } from "@/components/ui/FileViewer";
import { ToastProvider } from "@/components/ui/Toast";
import { ReviewCardItem } from "./ReviewCardItem";

const card = (flags: Partial<ReviewCard["flags"]> = {}, job: Partial<ReviewCard["job"]> = {}): ReviewCard => ({
  ...reviewCardFixture,
  job: { ...reviewCardFixture.job, ...job },
  flags: { ...reviewCardFixture.flags, ...flags },
});

function setup(c: ReviewCard) {
  const api = {
    mode: "live",
    events: { subscribe: () => () => {}, getStatus: () => "open", onStatus: () => () => {} },
    confirmInjection: vi.fn(async () => {}),
    fileUrl: (id: string) => `/api/files/${id}`,
  } as unknown as WebApi;
  render(
    <ApiProvider mode="live" api={api}>
      <ToastProvider>
        <FileViewerProvider>
          <ReviewCardItem card={c} acted={null} onApproved={() => {}} onChangesRequested={() => {}} onSkipped={() => {}} onInjectionConfirmed={() => {}} />
        </FileViewerProvider>
      </ToastProvider>
    </ApiProvider>,
  );
  return api;
}

describe("ReviewCardItem on the live orchestrator", () => {
  it("a flagged posting can be confirmed (POST /review/:jobId/confirm-injection is served)", async () => {
    setup(card({ injectionFlagged: true }, { injectionFlagged: true, injectionClearedAt: null }));
    const confirm = screen.getByRole("button", { name: "I checked it — enable Apply" });
    expect(confirm).toBeEnabled();
    expect(confirm).not.toHaveAttribute("title");
    await userEvent.click(confirm);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("PM3 S2: an “apply again” card shows that Ba applied before, above the card's actions", () => {
    setup(card({ appliedBefore: { applicationId: "4", at: "2026-10-10T08:40:00.000Z", status: "submitted", origin: "app" } }));
    expect(screen.getByText(/You applied to this job before \(2026-10-10 15:40 ICT, Submitted\)/)).toBeVisible();
  });

  it("W5: an Upwork card is find only: the note, “Open on Upwork”, no Approve", () => {
    setup(card({ findOnly: true }, { source: "upwork", url: "https://www.upwork.com/jobs/~021900000000000000001" }));
    expect(screen.getByTestId("flag-findOnly")).toHaveTextContent("Find only — apply yourself on Upwork");
    const open = screen.getByRole("link", { name: "Open on Upwork" });
    expect(open).toHaveAttribute("href", "https://www.upwork.com/jobs/~021900000000000000001");
    expect(open).toHaveAttribute("target", "_blank");
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
    expect(screen.queryByLabelText("Intro / cover text (optional)")).toBeNull();
    expect(screen.getByRole("button", { name: "Skip (give reason)" })).toBeInTheDocument();
  });

  it("a settled dry run offers Approve live and Skip, but not Request changes", () => {
    setup(card({ dryRunSettled: true }));
    expect(screen.getByRole("button", { name: "Approve live & submit" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skip (give reason)" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Request changes…" })).toBeNull();
  });

  it("a card waiting to be approved again offers Approve again and Skip, but not Request changes", () => {
    setup(card({ approveAgain: true }));
    expect(screen.getByRole("button", { name: "Approve again & submit" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Request changes…" })).toBeNull();
  });

  it("a card waiting for a first decision offers all three", () => {
    setup(card());
    expect(screen.getByRole("button", { name: "Request changes…" })).toBeInTheDocument();
  });
});
