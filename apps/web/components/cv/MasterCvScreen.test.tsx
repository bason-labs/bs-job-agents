import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ToastProvider } from "@/components/ui";
import { createFixtureMasterCvData } from "./data";
import { MasterCvScreen } from "./MasterCvScreen";

async function setup() {
  const data = createFixtureMasterCvData(undefined, () => new Date("2026-10-11T03:00:00Z"));
  const [cv, versions, requests] = await Promise.all([data.get(), data.versions(), data.factRequests()]);
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <MasterCvScreen initial={cv} initialVersions={versions} initialRequests={requests} data={data} />
    </ToastProvider>,
  );
  return { user, data };
}

describe("MasterCvScreen (UC-20)", () => {
  it("lists the facts with their ids, org and type", async () => {
    await setup();
    expect(screen.getByTestId("cv-header")).toHaveTextContent("Master version v7.");
    const facts = screen.getAllByTestId("fact");
    expect(facts.map((f) => f.dataset.factId)).toEqual(["grad-1", "grad-2", "grad-3", "grad-4", "aeg-1", "apc-1", "skill-1"]);
    expect(facts[0]).toHaveTextContent("Gradion · experience · Sep 2025 – present");
  });

  it("edits a fact and saves a new master version", async () => {
    const { user, data } = await setup();
    await user.click(screen.getByRole("button", { name: "Edit grad-2" }));
    const editor = screen.getByTestId("fact-editor");
    await user.type(within(editor).getByLabelText("Text (English)"), " Cut month-end close by 2 days.");
    expect(screen.getByText("unsaved changes")).toBeInTheDocument();
    await user.click(within(editor).getByRole("button", { name: "Done" }));
    await user.click(screen.getByTestId("cv-save"));

    expect(await screen.findByText("Master CV saved as v8 — review cards built on v7 will offer to regenerate.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("cv-header")).toHaveTextContent("Master version v8."));
    expect(screen.queryByText("unsaved changes")).toBeNull();
    expect(within(screen.getByTestId("cv-versions")).getAllByRole("listitem")[0]).toHaveTextContent("v8current7 facts · 2026-10-11 10:00");
    expect((await data.get()).facts[1]!.text).toMatch(/Cut month-end close by 2 days\.$/);
  });

  it("won't save a fact without text, and opens it for fixing", async () => {
    const { user, data } = await setup();
    await user.click(screen.getByRole("button", { name: "+ Add fact" }));
    expect(within(screen.getByTestId("fact-editor")).getByLabelText("Fact id")).toHaveValue("skill-2");
    await user.click(screen.getByTestId("cv-save"));
    expect(await screen.findByText("Fix the highlighted facts before saving")).toBeInTheDocument();
    expect(within(screen.getByTestId("fact-editor")).getByRole("alert")).toHaveTextContent("Write the fact's text");
    expect((await data.get()).version).toBe(7);
  });

  it("answers CV's question by adding a prefilled fact (§6.1)", async () => {
    const { user, data } = await setup();
    const request = screen.getByTestId("fact-request");
    expect(request).toHaveTextContent("CV asks: “Have you used GraphQL in a project?” NovaPay asks for it");
    await user.click(within(request).getByRole("button", { name: "Add a fact" }));
    expect(screen.queryByTestId("fact-request")).toBeNull();
    const text = within(screen.getByTestId("fact-editor")).getByLabelText("Text (English)");
    expect(text).toHaveValue("GraphQL — ");
    await user.type(text, "Apollo Client at Aegona");
    await user.click(screen.getByTestId("cv-save"));
    await screen.findByText(/Master CV saved as v8/);
    expect((await data.get()).facts.at(-1)).toMatchObject({ id: "skill-2", text: "GraphQL — Apollo Client at Aegona", tags: ["graphql"] });
  });

  it("removes a fact with Undo", async () => {
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: "Delete grad-4" }));
    expect(screen.getAllByTestId("fact")).toHaveLength(6);
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getAllByTestId("fact").map((f) => f.dataset.factId)).toContain("grad-4");
    expect(screen.queryByText("unsaved changes")).toBeNull();
  });
});
