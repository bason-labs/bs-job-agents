import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ToastProvider } from "@/components/ui";
import { CriteriaScreen } from "./CriteriaScreen";
import { createFixtureCriteriaData } from "./data";

async function setup() {
  const data = createFixtureCriteriaData(undefined, () => new Date("2026-10-11T03:00:00Z"));
  const [profile, versions] = await Promise.all([data.get(), data.versions()]);
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <CriteriaScreen initial={profile} initialVersions={versions.versions} data={data} />
    </ToastProvider>,
  );
  return { user, data };
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
    expect((await data.get()).version).toBe(3);
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
