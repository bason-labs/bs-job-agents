import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ToastProvider } from "@/components/ui";
import { testMock } from "@/lib/api/mock/testing";
import type { MockState } from "@/lib/api/mock/state";
import { ApiProvider } from "@/lib/api/react";
import { CriteriaLive, CriteriaScreen } from "./CriteriaScreen";
import { createCriteriaData, readCriteria } from "./data";
import { formToRequest, profileToForm } from "./logic";

const profileToFormForTest = (p: Parameters<typeof profileToForm>[0]) => formToRequest(profileToForm(p));

async function setup() {
  const data = createCriteriaData(testMock());
  const r = await readCriteria(data);
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <CriteriaScreen initial={r.profile} initialVersions={r.versions} initialAnswers={r.answers} data={data} />
    </ToastProvider>,
  );
  return { user, data };
}

function live(state?: (s: MockState) => void) {
  const mock = testMock({ state });
  const user = userEvent.setup();
  render(
    <ApiProvider mode="mock" api={mock}>
      <ToastProvider>
        <CriteriaLive />
      </ToastProvider>
    </ApiProvider>,
  );
  return { mock, user };
}

const save = () => screen.getByTestId("criteria-save");

describe("CriteriaScreen (UC-21b)", () => {
  it("shows the active profile and no unsaved changes", async () => {
    await setup();
    expect(screen.getByTestId("criteria-header")).toHaveTextContent(
      "Active profile v3 · updated 2026-10-10 · used by scheduled scans and chat requests",
    );
    expect(screen.queryByText("unsaved changes")).toBeNull();
    expect(screen.getByLabelText("Minimum salary")).toHaveValue("25,000,000");
  });

  it("adds and removes chips, marking the form dirty", async () => {
    const { user } = await setup();
    await user.type(screen.getByRole("textbox", { name: "Add to Roles" }), "Fullstack Engineer{Enter}");
    expect(within(screen.getByTestId("criteria-roles")).getByText("Fullstack Engineer")).toBeInTheDocument();
    expect(screen.getByText("unsaved changes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove Fullstack Engineer" }));
    expect(screen.queryByText("unsaved changes")).toBeNull();
  });

  it("refuses to save without a role, location or source", async () => {
    const { user, data } = await setup();
    await user.click(screen.getByRole("button", { name: "Remove Frontend Engineer" }));
    await user.click(screen.getByRole("button", { name: "Remove Software Engineer (React/Node)" }));
    await user.click(save());
    expect(await screen.findByText("Need at least one role, location and source")).toBeInTheDocument();
    expect(screen.getByText("Add at least one role")).toBeInTheDocument();
    expect((await data.get())?.version).toBe(3);
  });

  it("shows saved answers and forgets one after confirming (UC-12)", async () => {
    const { user, data } = await setup();
    const list = screen.getByTestId("saved-answers");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(list).toHaveTextContent("Notice period2 weeks");

    await user.click(screen.getByRole("button", { name: "Forget the answer for Work permit" }));
    const confirm = screen.getByTestId("confirm-dialog");
    expect(confirm).toHaveTextContent("Forget the answer for “Work permit”?");
    await user.click(within(confirm).getByRole("button", { name: "Forget answer" }));
    expect(await screen.findByText("Forgot the answer for “Work permit”")).toBeInTheDocument();
    expect(within(screen.getByTestId("saved-answers")).getAllByRole("listitem")).toHaveLength(1);
    expect((await data.savedAnswers()).map((a) => a.label)).not.toContain("Work permit");
  });

  it("needs an amount for the fixed salary rule, then saves a new version", async () => {
    const { user, data } = await setup();
    await user.click(screen.getByTestId("criteria-salary-policy"));
    await user.click(screen.getByRole("option", { name: "Use a fixed amount" }));
    expect(screen.getByTestId("criteria-salary-note")).toHaveTextContent("Apply writes this amount in the expected-salary field.");
    await user.click(save());
    expect(await screen.findAllByText("Enter the amount Apply should write")).not.toHaveLength(0);

    await user.type(screen.getByLabelText("Amount (VND)"), "30000000");
    expect(screen.getByLabelText("Amount (VND)")).toHaveValue("30,000,000");
    await user.click(save());

    expect(await screen.findByText("Search criteria saved as v4")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("criteria-header")).toHaveTextContent("Active profile v4 · updated just now"));
    expect(screen.queryByText("unsaved changes")).toBeNull();
    expect(within(screen.getByTestId("criteria-versions")).getAllByRole("listitem")[0]).toHaveTextContent("v4active");
    expect(await data.get()).toMatchObject({ version: 4, salaryPolicy: "fixed", salaryAmount: 30_000_000 });
  });
});

describe("CriteriaLive (the page)", () => {
  it("takes a newer version read in the background (saved from chat) while Ba is not editing", async () => {
    const mock = testMock();
    const data = createCriteriaData(mock);
    const first = await readCriteria(data);
    const { rerender } = render(
      <ToastProvider>
        <CriteriaScreen initial={first.profile} initialVersions={first.versions} initialAnswers={first.answers} data={data} />
      </ToastProvider>,
    );
    await data.save({ ...profileToFormForTest(first.profile!), locations: ["Ho Chi Minh City", "Đà Nẵng"] });
    const next = await readCriteria(data);
    rerender(
      <ToastProvider>
        <CriteriaScreen initial={next.profile} initialVersions={next.versions} initialAnswers={next.answers} data={data} />
      </ToastProvider>,
    );
    expect(screen.getByTestId("criteria-header")).toHaveTextContent("Active profile v4");
    expect(within(screen.getByTestId("criteria-locations")).getByText("Đà Nẵng")).toBeInTheDocument();
  });

  it("reads the criteria through the api", async () => {
    live();
    expect(await screen.findByTestId("criteria-header")).toHaveTextContent("Active profile v3");
  });

  it("before the first save: an empty form whose save creates v1", async () => {
    const { user, mock } = live((s) => (s.profiles = []));
    expect(await screen.findByTestId("criteria-header")).toHaveTextContent("No search criteria yet · saving creates v1");
    await user.type(screen.getByRole("textbox", { name: "Add to Roles" }), "Frontend Engineer{Enter}");
    await user.type(screen.getByRole("textbox", { name: "Add to Locations" }), "Ho Chi Minh City{Enter}");
    await user.click(save());
    expect(await screen.findByText("Search criteria saved as v1")).toBeInTheDocument();
    expect(mock.state.profiles).toHaveLength(1);
  });
});
