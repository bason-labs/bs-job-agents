import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ToastProvider } from "@/components/ui";
import { MASTER_CV } from "@/lib/api/mock/seed-master-cv";
import type { MockMasterCv } from "@/lib/api/mock/state";
import { testMock } from "@/lib/api/mock/testing";
import { ApiProvider } from "@/lib/api/react";
import { createMasterCvData, readMasterCvPage, type MasterCvData } from "./data";
import { MasterCvLive, MasterCvScreen } from "./MasterCvScreen";

async function cvOf(data: MasterCvData) {
  const read = await data.get();
  if (read.state !== "ok") throw new Error(`no master CV (${read.state})`);
  return read.cv;
}

async function setup(opts: { file?: MockMasterCv } = {}) {
  const mock = testMock({ state: (s) => void (opts.file && (s.masterCv = opts.file)) });
  const data = createMasterCvData(mock);
  const page = await readMasterCvPage(data);
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <MasterCvScreen initial={page.read} initialVersions={page.versions} initialRequests={page.requests} data={data} />
    </ToastProvider>,
  );
  return { user, data, mock };
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
    expect((await cvOf(data)).facts[1]!.text).toMatch(/Cut month-end close by 2 days\.$/);
  });

  it("won't save a fact without text, and opens it for fixing", async () => {
    const { user, data } = await setup();
    await user.click(screen.getByRole("button", { name: "+ Add fact" }));
    expect(within(screen.getByTestId("fact-editor")).getByLabelText("Fact id")).toHaveValue("skill-2");
    await user.click(screen.getByTestId("cv-save"));
    expect(await screen.findByText("Fix the highlighted facts before saving")).toBeInTheDocument();
    expect(within(screen.getByTestId("fact-editor")).getByRole("alert")).toHaveTextContent("Write the fact's text");
    expect((await cvOf(data)).version).toBe(7);
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
    expect((await cvOf(data)).facts.at(-1)).toMatchObject({ id: "skill-2", text: "GraphQL — Apollo Client at Aegona", tags: ["graphql"] });
    // Answered with a saved fact: closed on the server too, so it doesn't come back.
    expect((await data.factRequests()).map((r) => r.topic)).not.toContain("GraphQL");
    expect(screen.queryAllByTestId("fact-request").map((r) => r.textContent)).not.toContain(expect.stringMatching(/GraphQL/));
  });

  it("“No, I don't” closes CV's question on the server", async () => {
    const { user, data } = await setup();
    const before = (await data.factRequests()).length;
    await user.click(within(screen.getAllByTestId("fact-request")[0]!).getByRole("button", { name: "No, I don't" }));
    expect(await screen.findByText(/CV goes on without/)).toBeInTheDocument();
    expect(await data.factRequests()).toHaveLength(before - 1);
  });

  it("asks to reload when the master CV changed since it was opened (409 master_cv_changed)", async () => {
    const { user, data } = await setup();
    // Another tab saves v8 meanwhile.
    await data.save(await cvOf(data));
    await user.click(screen.getByRole("button", { name: "Edit grad-2" }));
    await user.type(within(screen.getByTestId("fact-editor")).getByLabelText("Text (English)"), " Edited.");
    await user.click(screen.getByTestId("cv-save"));
    const banner = await screen.findByTestId("cv-conflict");
    expect(banner).toHaveTextContent("The master CV changed since you opened it (now v8)");
    expect(screen.getByTestId("cv-save")).toBeDisabled();
    await user.click(within(banner).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(screen.getByTestId("cv-header")).toHaveTextContent("Master version v8."));
    expect(screen.queryByTestId("cv-conflict")).toBeNull();
    expect(screen.queryByText("unsaved changes")).toBeNull();
  });

  it("offers to create a master CV when there is none (404)", async () => {
    const { user, data } = await setup({ file: { kind: "missing" } });
    expect(screen.getByText("No master CV yet")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create master CV" }));
    expect(screen.getByTestId("cv-header")).toHaveTextContent("New master CV — not saved yet.");
    await user.type(screen.getByLabelText("Name"), MASTER_CV.contact.name);
    await user.type(screen.getByLabelText("Email"), MASTER_CV.contact.email);
    await user.type(within(screen.getByTestId("fact-editor")).getByLabelText("Text (English)"), "TypeScript, React, Next.js");
    await user.click(screen.getByTestId("cv-save"));
    expect(await screen.findByText("Master CV created (v1)")).toBeInTheDocument();
    expect((await cvOf(data)).facts).toHaveLength(1);
  });

  it("explains an unreadable master-cv.yaml, and reloads once it is fixed (409 master_cv_invalid)", async () => {
    const { user, mock } = await setup({ file: { kind: "invalid", detail: "facts.2.id: fact ids are lowercase slugs" } });
    expect(screen.getByText("data/master-cv.yaml can't be read")).toBeInTheDocument();
    expect(screen.getByTestId("cv-invalid")).toHaveTextContent("facts.2.id: fact ids are lowercase slugs");
    mock.state.masterCv = { kind: "ok", cv: structuredClone(MASTER_CV) };
    await user.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(screen.getByTestId("cv-header")).toHaveTextContent("Master version v7."));
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

describe("MasterCvLive (the page)", () => {
  it("reads the master CV, its history and the open fact requests through the api", async () => {
    const mock = testMock();
    render(
      <ApiProvider mode="mock" api={mock}>
        <ToastProvider>
          <MasterCvLive />
        </ToastProvider>
      </ApiProvider>,
    );
    expect(await screen.findByTestId("cv-header")).toHaveTextContent("Master version v7.");
    expect(screen.getAllByTestId("fact-request").length).toBeGreaterThan(0);
    expect(within(screen.getByTestId("cv-versions")).getAllByRole("listitem")).toHaveLength(3);
  });
});
