// API research (design 2026-10-19 §5.6): each source toggle's access label, Approve and Revoke.
import { API_READER_BOARDS, ACCESS_LABELS, sourceAccessRecord, type SourceAccessView } from "@bs-job-agents/shared";
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
/** The production readers without LinkedIn's: a board with no API reader. */
const NO_LINKEDIN_READER = API_READER_BOARDS.filter((s) => s !== "linkedin");

async function setup(o: { state?: (s: MockState) => void; data?: (d: CriteriaData) => CriteriaData } = {}) {
  const mock = testMock({ state: (s) => o.state?.(s) });
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
    expect(labelOf("linkedin")).toHaveTextContent("Direct read (needs approval) · Browser until approved");
    expect(within(cell("linkedin")).getByRole("button", { name: "Approve direct reads for LinkedIn" })).toBeInTheDocument();
    expect(within(cell("remotive")).queryByRole("button", { name: /Approve|Revoke/ })).toBeNull();
  });

  it("VietnamWorks (low risk, no login) reads Direct (no login) with nothing to approve", async () => {
    await setup();
    await waitFor(() => expect(labelOf("vietnamworks")).toHaveTextContent(/^Direct \(no login\)$/));
    expect(within(cell("vietnamworks")).queryByRole("button", { name: /Approve|Revoke/ })).toBeNull();
    expect(within(cell("vietnamworks")).queryByTestId("source-token-hint")).toBeNull();
  });

  it("a board without an API reader shows Browser and has no Approve", async () => {
    await setup({ state: (s) => (s.sourceAccess = { approvals: {}, tokens: [], readers: NO_LINKEDIN_READER }) });
    await waitFor(() => expect(labelOf("linkedin")).toHaveTextContent(/^Browser$/));
    expect(within(cell("linkedin")).queryByRole("button", { name: /Approve|Revoke/ })).toBeNull();
  });

  it("Approve shows the terms URL, quoted clauses and account risk; confirming approves, then Revoke undoes it", async () => {
    const { user, mock } = await setup();
    const approve = await within(cell("linkedin")).findByRole("button", { name: "Approve direct reads for LinkedIn" });
    await user.click(approve);

    const dialog = screen.getByRole("dialog", { name: "Approve direct reads for LinkedIn?" });
    expect(within(dialog).getByRole("link", { name: new RegExp(linkedin.termsOfUse.url.replace(/[.?/]/g, "\\$&")) })).toHaveAttribute("href", linkedin.termsOfUse.url);
    for (const c of linkedin.termsOfUse.clauses) expect(dialog).toHaveTextContent(`“${c}”`);
    expect(dialog).toHaveTextContent(linkedin.accountRisk);
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    await user.click(within(dialog).getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("Approved direct reads for LinkedIn")).toBeInTheDocument();
    expect(mock.state.sourceAccess?.approvals.linkedin?.researchedAt).toBe(linkedin.researchedAt);
    expect(screen.queryByRole("dialog")).toBeNull();
    // LinkedIn is read without logging in: approved, it reads Direct (no login), and no token is asked for.
    expect(labelOf("linkedin")).toHaveTextContent(/^Direct \(no login\)$/);
    expect(within(cell("linkedin")).queryByTestId("source-token-hint")).toBeNull();
    const revoke = within(cell("linkedin")).getByRole("button", { name: "Revoke direct reads for LinkedIn" });
    await waitFor(() => expect(revoke).toHaveFocus());

    await user.click(revoke);
    expect(await screen.findByText("Revoked: LinkedIn is read in the browser again")).toBeInTheDocument();
    expect(labelOf("linkedin")).toHaveTextContent("Direct read (needs approval)");
    expect(mock.state.sourceAccess?.approvals.linkedin).toBeUndefined();
  });

  it("the approve dialog says a no-login board is read without a token or cookie", async () => {
    const { user } = await setup();
    await user.click(await within(cell("linkedin")).findByRole("button", { name: "Approve direct reads for LinkedIn" }));
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription(/without logging in: no token or cookie is sent/);
  });

  /** The mock's views with LinkedIn's replaced: a board read with an account token (none in production today). */
  const withLinkedin = (patch: Partial<SourceAccessView>) => (d: CriteriaData): CriteriaData => ({
    ...d,
    sourceAccess: async () => (await d.sourceAccess()).map((v) => (v.source === "linkedin" ? { ...v, noLogin: false, ...patch } : v)),
  });

  it("an approved account-API board without its token: token missing, with where to put it", async () => {
    await setup({ data: withLinkedin({ path: "account_api", labelKey: "account_api_token_missing", needsApproval: false, tokenMissing: true, approvedAt: "2026-10-11T02:00:00.000Z" }) });
    await waitFor(() => expect(labelOf("linkedin")).toHaveTextContent("Account API (token missing) · Browser until a token is set"));
    expect(within(cell("linkedin")).getByTestId("source-token-hint")).toHaveTextContent(TOKEN_HINT);
    expect(within(cell("linkedin")).getByRole("button", { name: "Revoke the account API for LinkedIn" })).toBeInTheDocument();
  });

  it("an approved board with its token configured reads Account API", async () => {
    await setup({ data: withLinkedin({ path: "account_api", labelKey: "account_api", needsApproval: false, tokenMissing: false, approvedAt: "2026-10-11T02:00:00.000Z" }) });
    await waitFor(() => expect(labelOf("linkedin")).toHaveTextContent(new RegExp(`^${ACCESS_LABELS.account_api}$`)));
    expect(within(cell("linkedin")).queryByTestId("source-token-hint")).toBeNull();
    expect(within(cell("linkedin")).getByRole("button", { name: "Revoke the account API for LinkedIn" })).toBeInTheDocument();
  });

  it("Cancel and Escape close the dialog without approving, and focus returns to Approve", async () => {
    const { user, mock } = await setup();
    const approve = await within(cell("linkedin")).findByRole("button", { name: "Approve direct reads for LinkedIn" });
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
    await user.click(await within(cell("linkedin")).findByRole("button", { name: "Approve direct reads for LinkedIn" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve" }));
    expect(await screen.findByText(/Couldn't approve LinkedIn: .*research changed/)).toBeInTheDocument();
    await waitFor(() => expect(labelOf("linkedin")).toHaveTextContent("Direct read (needs approval)"));
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
