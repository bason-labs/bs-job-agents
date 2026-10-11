import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FileViewerProvider, ToastProvider } from "@/components/ui";
import { ApplicationsScreen } from "./ApplicationsScreen";
import { createFixtureApplicationsData } from "./data";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const NOW = new Date("2026-10-11T03:00:00Z");

async function setup() {
  const data = createFixtureApplicationsData({ now: () => NOW });
  const initial = await data.list();
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <FileViewerProvider>
        <ApplicationsScreen initial={initial} data={data} />
      </FileViewerProvider>
    </ToastProvider>,
  );
  return { user, data };
}

const row = (company: string) => screen.getAllByTestId("application-row").find((r) => within(r).queryByText(company, { exact: true }))!;

describe("ApplicationsScreen (UC-13)", () => {
  it("lists every application with badges, the CV file, status and proof", async () => {
    await setup();
    expect(screen.getAllByTestId("application-row")).toHaveLength(7);
    expect(screen.getByTestId("applications-header")).toHaveTextContent("7 applications · stored on this Mac in data/");
    expect(within(row("DEKON")).getByText("imported")).toBeInTheDocument();
    expect(within(row("Kite Labs")).getByText("dry run")).toBeInTheDocument();
    expect(within(row("NovaPay")).getByRole("button", { name: "NOVAPAY_SENIOR-FRONTEND_EN_v1.pdf" })).toBeInTheDocument();
    expect(within(row("NovaPay")).getByRole("button", { name: "screenshot" })).toBeInTheDocument();
    expect(within(row("Sao Việt Tech")).getByText("not captured")).toBeInTheDocument();
    // Statuses Ba can't change are read-only.
    expect(within(row("Bluebird Software")).queryByRole("combobox")).toBeNull();
    expect(within(row("Bluebird Software")).getByText("Failed")).toBeInTheDocument();
  });

  it("changes a status from the row and shows it in the record's history", async () => {
    const { user } = await setup();
    await user.click(within(row("NovaPay")).getByRole("combobox", { name: "Status of NovaPay" }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Submitted", "Interviewing", "Offer", "Rejected", "Withdrawn", "No response"]);
    await user.click(screen.getByRole("option", { name: "Interviewing" }));
    await waitFor(() => expect(within(row("NovaPay")).getByRole("combobox")).toHaveTextContent("Interviewing"));
    // Choosing an option does not open the record panel.
    expect(screen.queryByTestId("record-panel")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Open NovaPay's submission record" }));
    const history = await screen.findByTestId("record-history");
    expect(within(history).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "approved2026-10-10 15:36",
      "submitted2026-10-10 15:40",
      "interviewing2026-10-11 10:00",
    ]);
  });

  it("opens the record panel with every part of the submission", async () => {
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: "Open NovaPay's submission record" }));
    const panel = await screen.findByTestId("record-panel");
    expect(within(panel).getByText("Submission record")).toBeInTheDocument();
    expect(await within(panel).findByTestId("record-sha")).toHaveTextContent(`SHA-256: 6618f61f79198cbad7d0e3f7255575840b40d317878fab7393a1b7b6ffc589ec`);
    const fields = within(panel).getByTestId("record-fields");
    expect(fields).toHaveTextContent("Expected salary (USD) · optional— left blank (optional)left blank — optional");
    expect(fields).toHaveTextContent("Notice period2 weekssaved answer");
    expect(within(panel).getByTestId("record-approval")).toHaveTextContent("allowed sites: itviec.com");
    expect(within(panel).getByRole("button", { name: /JD snapshot/ })).toHaveTextContent("frozen 2026-10-10 15:39");

    // Files open in the viewer first (spec §11), with Download inside.
    await user.click(within(panel).getByRole("button", { name: /JD snapshot/ }));
    const viewer = await screen.findByTestId("file-viewer");
    expect(within(viewer).getByText("NovaPay_JD_snapshot.txt")).toBeInTheDocument();
    expect(within(viewer).getByTestId("file-viewer-text")).toHaveTextContent("Build product features with React/Next.js");
    expect(within(viewer).getByRole("link", { name: "Download" })).toHaveAttribute("href", "/dev/sample-jd.txt");
  });

  it("shows “not captured” for an imported record's missing parts", async () => {
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: "Open DEKON's submission record" }));
    const panel = await screen.findByTestId("record-panel");
    expect(within(panel).getByText("Submission record · imported, partial")).toBeInTheDocument();
    expect(await within(panel).findByTestId("record-sha")).toHaveTextContent("SHA-256: not captured");
    expect(within(panel).getByRole("button", { name: /Before submit/ })).toBeDisabled();
    expect(within(panel).getByRole("button", { name: /JD snapshot/ })).toHaveTextContent("not captured (applied before this app)");
  });

  it("exports all applications and shows the last export date (UC-13b)", async () => {
    const { user } = await setup();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await user.click(screen.getByRole("button", { name: "Export all (ZIP)" }));
    expect(await screen.findByText("Exported 6 applications → job-agents-export_2026-10-11.zip")).toBeInTheDocument();
    expect(click).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("applications-header")).toHaveTextContent("last export 2026-10-11 10:00");
    click.mockRestore();
  });

  it("offers Apply again for a failed application, after a confirmation", async () => {
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: "Open Bluebird Software's submission record" }));
    const panel = await screen.findByTestId("record-panel");
    expect(await within(panel).findByText("No submission record — nothing was sent to the employer.")).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Apply again…" }));
    const confirm = screen.getByTestId("confirm-dialog");
    await user.click(within(confirm).getByRole("button", { name: "Send to review" }));
    expect(await screen.findByText(/Bluebird Software is back in your review queue/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open review" }));
    expect(push).toHaveBeenCalledWith("/review");
  });
});
