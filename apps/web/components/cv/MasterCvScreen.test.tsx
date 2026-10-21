import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ToastProvider } from "@/components/ui";
import { MASTER_CV } from "@/lib/api/mock/seed-master-cv";
import type { MockMasterCv, MockState } from "@/lib/api/mock/state";
import { gatedSleep, testMock } from "@/lib/api/mock/testing";
import { ApiProvider } from "@/lib/api/react";
import { createMasterCvData, readMasterCvPage, type MasterCvData } from "./data";
import { MasterCvLive, MasterCvScreen } from "./MasterCvScreen";

async function cvOf(data: MasterCvData) {
  const read = await data.get();
  if (read.state !== "ok") throw new Error(`no master CV (${read.state})`);
  return read.cv;
}

async function setup(opts: { file?: MockMasterCv; sleep?: (ms: number) => Promise<void>; requests?: MockState["factRequests"] } = {}) {
  const mock = testMock({
    state: (s) => {
      if (opts.file) s.masterCv = opts.file;
      if (opts.requests) s.factRequests = opts.requests;
    },
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
  });
  const data = createMasterCvData(mock, { pollMs: 5 });
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

  it("CV guidance (§5.8): a months request is labelled with its rule, asked once for two jobs, and opens the fact's own editor", async () => {
    const { user } = await setup({
      requests: [
        {
          id: "g-dates-month-year-grad-2-dates",
          jobId: "101",
          company: "NovaPay",
          topic: "Education and experience dates give month and year",
          question: "What were the start and end months of grad-2?",
          reason: "CV guidance: Education and experience dates give month and year",
          origin: "guidance",
          ruleId: "dates-month-year",
          ruleLabel: "Education and experience dates give month and year",
          factId: "grad-2",
          field: "dates",
          alsoJobIds: ["102"],
        },
      ],
    });
    expect(screen.getByTestId("guidance-request")).toHaveTextContent("From CV guidance: Education and experience dates give month and year. “What were the start and end months of grad-2?” Asked once for 2 jobs.");
    await user.click(screen.getByTestId("edit-fact"));
    expect(await screen.findByTestId("fact-editor")).toBeInTheDocument();
    expect(within(screen.getByTestId("fact-editor")).getByLabelText("Fact id")).toHaveValue("grad-2");
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

  it("answers CV's question in free text: CV adds the fact, shown with Added, Undo and Edit; the question goes (owner request 2026-10-11)", async () => {
    const { user, data } = await setup();
    const request = screen.getByTestId("fact-request");
    expect(request).toHaveTextContent("CV asks: “Have you used GraphQL in a project?” NovaPay asks for it");
    expect(within(request).queryByRole("button", { name: "Add a fact" })).toBeNull();
    expect(within(request).getByRole("button", { name: "Add" })).toBeDisabled();
    await user.type(within(request).getByRole("textbox", { name: /Your answer/ }), "Yes, I used GraphQL with Apollo Client at Aegona.");
    await user.click(within(request).getByRole("button", { name: "Add" }));

    const added = await screen.findByTestId("fact-added");
    expect(added.dataset.factId).toBe("aeg-2");
    expect(added).toHaveTextContent("Addedfrom your words");
    expect(added).toHaveTextContent("I used GraphQL with Apollo Client at Aegona.");
    expect(screen.queryByTestId("fact-request")).toBeNull();
    expect(screen.getByTestId("cv-header")).toHaveTextContent("Master version v8.");
    expect(screen.queryByText("unsaved changes")).toBeNull();
    expect((await cvOf(data)).facts.at(-1)).toMatchObject({ id: "aeg-2", org: "Aegona", dates: "Feb 2024 – Sep 2025", tags: ["graphql"] });
    expect(await data.factRequests()).toEqual([]);
    expect(screen.getByTestId("retailor-banner")).toHaveTextContent("Re-tailor CVs for: NovaPay");

    // Edit opens the fact editor on it.
    await user.click(within(added).getByRole("button", { name: "Edit" }));
    expect(within(screen.getByTestId("fact-editor")).getByLabelText("Fact id")).toHaveValue("aeg-2");
  });

  it("Undo removes the added fact, restores the version before (as a new version) and brings the question back", async () => {
    const { user, data } = await setup();
    const request = screen.getByTestId("fact-request");
    await user.type(within(request).getByRole("textbox", { name: /Your answer/ }), "Yes, I used GraphQL with Apollo Client at Aegona.");
    await user.click(within(request).getByRole("button", { name: "Add" }));
    await user.click(within(await screen.findByTestId("fact-added")).getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Undone — master CV restored as v9.")).toBeInTheDocument();
    expect(screen.queryByTestId("fact-added")).toBeNull();
    expect(screen.getAllByTestId("fact").map((f) => f.dataset.factId)).not.toContain("aeg-2");
    expect(screen.getByTestId("cv-header")).toHaveTextContent("Master version v9.");
    expect((await cvOf(data)).facts.map((f) => f.id)).not.toContain("aeg-2");
    expect(await screen.findByTestId("fact-request")).toBeInTheDocument();
    expect(screen.queryByTestId("retailor-banner")).toBeNull();
  });

  it("shows CV's progress while it drafts, then the facts from the free-text box (⌘+Enter)", async () => {
    const gate = gatedSleep();
    const { user } = await setup({ sleep: gate.sleep });
    const box = within(screen.getByTestId("fact-free-text")).getByRole("textbox", { name: "Tell me something new about your experience" });
    await user.type(box, "I mentor two junior developers at Gradion");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(await screen.findByTestId("fact-drafting")).toHaveTextContent("CV is turning your words into facts…");
    expect(box).toBeDisabled();
    gate.release();
    const added = await screen.findByTestId("fact-added");
    expect(added).toHaveTextContent("I mentor two junior developers at Gradion");
    expect(screen.queryByTestId("fact-drafting")).toBeNull();
    expect(box).toHaveValue("");
    // A free-text fact answers no job's question: nothing to re-tailor.
    expect(screen.queryByTestId("retailor-banner")).toBeNull();
  });

  it("shows CV's note and adds nothing when Ba's answer is no", async () => {
    const { user, data } = await setup();
    const request = screen.getByTestId("fact-request");
    await user.type(within(request).getByRole("textbox", { name: /Your answer/ }), "No, never used it.");
    await user.click(within(request).getByRole("button", { name: "Add" }));
    expect(await within(request).findByTestId("fact-draft-note")).toHaveTextContent("You said no, so I added nothing.");
    expect(screen.queryByTestId("fact-added")).toBeNull();
    expect((await cvOf(data)).version).toBe(7);
  });

  it("re-tailors the CVs of the jobs whose questions Ba answered", async () => {
    const { user, mock } = await setup();
    const request = screen.getByTestId("fact-request");
    await user.type(within(request).getByRole("textbox", { name: /Your answer/ }), "Yes, I used GraphQL with Apollo Client at Aegona.");
    await user.click(within(request).getByRole("button", { name: "Add" }));
    const banner = await screen.findByTestId("retailor-banner");
    await user.click(within(banner).getByRole("button", { name: "Re-tailor CVs" }));
    expect(await within(banner).findByTestId("retailor-results")).toHaveTextContent("NovaPay: CV is tailoring it again");
    await mock.idle();
  });

  it("a draft sent from a stale page shows the reload banner (409 master_cv_changed)", async () => {
    const { user, data } = await setup();
    await data.save(await cvOf(data)); // another tab saves v8
    await user.type(within(screen.getByTestId("fact-free-text")).getByRole("textbox"), "I mentor two juniors at Gradion");
    await user.click(screen.getByRole("button", { name: "Add facts" }));
    expect(await screen.findByTestId("cv-conflict")).toHaveTextContent("now v8");
    expect(screen.queryByTestId("fact-added")).toBeNull();
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
