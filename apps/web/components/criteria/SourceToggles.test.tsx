// API research (design 2026-10-19 §5.6): each source toggle's access label, Approve and Revoke.
import { sourceAccessRecord } from "@bs-job-agents/shared";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ToastProvider } from "@/components/ui";
import { ApiRequestError } from "@/lib/api/errors";
import type { MockState } from "@/lib/api/mock/state";
import { testMock } from "@/lib/api/mock/testing";
import { CriteriaScreen } from "./CriteriaScreen";
import { createCriteriaData, readCriteria, type CriteriaData } from "./data";
import { TOKEN_HINT } from "./SourceToggles";

const linkedin = sourceAccessRecord("linkedin");

async function setup(o: { state?: (s: MockState) => void; data?: (d: CriteriaData) => CriteriaData } = {}) {
  const mock = testMock({ state: o.state });
  const base = createCriteriaData(mock);
  const data = o.data ? o.data(base) : base;
  const r = await readCriteria(base);
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <CriteriaScreen initial={r.profile} initialVersions={r.versions} initialAnswers={r.answers} data={data} />
    </ToastProvider>,
  );
  return { user, mock, data };
}

const toggle = (name: string) => within(screen.getByTestId("criteria-sources")).getByRole("button", { name });
const cell = (source: string) => screen.getByTestId(`source-${source}`);
const labelOf = (source: string) => within(cell(source)).getByTestId("source-access-label");

describe("source access labels (§5.6)", () => {
  it("shows no label while loading, then each source's label as the toggle's description", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await setup({ data: (d) => ({ ...d, sourceAccess: async () => (await gate, d.sourceAccess()) }) });
    expect(labelOf("remotive")).toBeEmptyDOMElement();
    expect(toggle("Remotive")).not.toHaveAttribute("aria-describedby");

    release();
    await waitFor(() => expect(labelOf("remotive")).toHaveTextContent("Public API"));
    expect(toggle("Remotive")).toHaveAccessibleDescription("Public API");
    expect(toggle("Upwork")).toHaveAccessibleDescription("Browser");
    // The toggle's name stays the board's name.
    expect(toggle("LinkedIn")).toHaveAttribute("aria-pressed", "true");
  });

  it("a no-login board reads Direct (no login); an unapproved high-risk board says it is read in the browser until approved", async () => {
    await setup();
    await waitFor(() => expect(labelOf("linkedin")).not.toBeEmptyDOMElement());
    for (const s of ["topcv", "itviec"] as const) {
      const r = sourceAccessRecord(s);
      if (r.chosenPath === "account_api" && r.auth.kind === "none" && r.riskLevel === "low") expect(labelOf(s)).toHaveTextContent("Direct (no login)");
    }
    expect(labelOf("linkedin")).toHaveTextContent("Account API (needs approval) · Browser until approved");
    expect(within(cell("linkedin")).getByRole("button", { name: "Approve the account API for LinkedIn" })).toBeInTheDocument();
    expect(within(cell("remotive")).queryByRole("button", { name: /Approve|Revoke/ })).toBeNull();
  });

  it("Approve shows the terms URL, quoted clauses and account risk; confirming approves, then Revoke undoes it", async () => {
    const { user, mock } = await setup();
    const approve = await within(cell("linkedin")).findByRole("button", { name: "Approve the account API for LinkedIn" });
    await user.click(approve);

    const dialog = screen.getByRole("dialog", { name: "Approve the account API for LinkedIn?" });
    expect(within(dialog).getByRole("link", { name: new RegExp(linkedin.termsOfUse.url.replace(/[.?/]/g, "\\$&")) })).toHaveAttribute("href", linkedin.termsOfUse.url);
    for (const c of linkedin.termsOfUse.clauses) expect(dialog).toHaveTextContent(`“${c}”`);
    expect(dialog).toHaveTextContent(linkedin.accountRisk);
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    await user.click(within(dialog).getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("Approved the account API for LinkedIn")).toBeInTheDocument();
    expect(mock.state.sourceAccess?.approvals.linkedin?.researchedAt).toBe(linkedin.researchedAt);
    expect(screen.queryByRole("dialog")).toBeNull();
    // No token in the secrets file yet: token missing, with where to put it.
    expect(labelOf("linkedin")).toHaveTextContent("Account API (token missing) · Browser until a token is set");
    expect(within(cell("linkedin")).getByTestId("source-token-hint")).toHaveTextContent(TOKEN_HINT);
    const revoke = within(cell("linkedin")).getByRole("button", { name: "Revoke the account API for LinkedIn" });
    await waitFor(() => expect(revoke).toHaveFocus());

    await user.click(revoke);
    expect(await screen.findByText("Revoked: LinkedIn is read in the browser again")).toBeInTheDocument();
    expect(labelOf("linkedin")).toHaveTextContent("Account API (needs approval)");
    expect(mock.state.sourceAccess?.approvals.linkedin).toBeUndefined();
  });

  it("an approved board with its token configured reads Account API", async () => {
    await setup({ state: (s) => (s.sourceAccess = { approvals: { linkedin: { approvedAt: "2026-10-11T02:00:00.000Z", researchedAt: linkedin.researchedAt } }, tokens: ["linkedin"] }) });
    await waitFor(() => expect(labelOf("linkedin")).toHaveTextContent(/^Account API$/));
    expect(within(cell("linkedin")).queryByTestId("source-token-hint")).toBeNull();
    expect(within(cell("linkedin")).getByRole("button", { name: "Revoke the account API for LinkedIn" })).toBeInTheDocument();
  });

  it("Cancel and Escape close the dialog without approving, and focus returns to Approve", async () => {
    const { user, mock } = await setup();
    const approve = await within(cell("linkedin")).findByRole("button", { name: "Approve the account API for LinkedIn" });
    await user.click(approve);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(approve).toHaveFocus());

    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mock.state.sourceAccess?.approvals.linkedin).toBeUndefined();
  });

  it("a stale research (409) shows the error and re-reads the labels", async () => {
    const { user } = await setup({ data: (d) => ({ ...d, approveSource: (s) => d.approveSource(s, "an older research") }) });
    await user.click(await within(cell("linkedin")).findByRole("button", { name: "Approve the account API for LinkedIn" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve" }));
    expect(await screen.findByText(/Couldn't approve LinkedIn: .*research changed/)).toBeInTheDocument();
    await waitFor(() => expect(labelOf("linkedin")).toHaveTextContent("Account API (needs approval)"));
  });

  it("if the labels fail to load, the error shows with Retry, and the toggles still work", async () => {
    let fail = true;
    const { user } = await setup({
      data: (d) => ({
        ...d,
        sourceAccess: () => (fail ? Promise.reject(new ApiRequestError({ status: 0, code: "unreachable", message: "orchestrator unreachable", details: null })) : d.sourceAccess()),
      }),
    });
    const error = await screen.findByTestId("source-access-error");
    expect(within(error).getByRole("alert")).toHaveTextContent("Couldn't load how each source is read");
    expect(labelOf("remotive")).toBeEmptyDOMElement();
    await user.click(toggle("Remotive"));
    expect(toggle("Remotive")).toHaveAttribute("aria-pressed", "true");

    fail = false;
    await user.click(within(error).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(labelOf("remotive")).toHaveTextContent("Public API"));
    expect(screen.queryByTestId("source-access-error")).toBeNull();
  });
});
