// CV auto-extend (§7): the Master CV screen's derived-fact states on the mock orchestrator:
// labelled derived facts with links to their sources, the undo bar (latest and not latest), the
// flagged "Source fact changed" state with Keep and Delete, and the collapsed "Not added" region.
import type { DeriveCandidate, MasterCv } from "@bs-job-agents/shared";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { ToastProvider } from "@/components/ui";
import { mockDeriveFacts } from "@/lib/api/mock/derived-facts";
import { MASTER_CV } from "@/lib/api/mock/seed-master-cv";
import { testMock } from "@/lib/api/mock/testing";
import { createMasterCvData, readMasterCvPage } from "./data";
import { MasterCvScreen } from "./MasterCvScreen";

const redux: DeriveCandidate = {
  requirement: "Redux",
  type: "skill",
  text: "Redux",
  textVi: "Redux",
  tags: ["redux"],
  restsOn: [{ factId: "apc-1", relation: "implied_from" }],
  fromTerms: ["Next.js"],
  rationale: "Redux is the common state library for React and Next.js apps.",
  via: "table",
};
const cicd: DeriveCandidate = { ...redux, requirement: "CI/CD", text: "CI/CD", textVi: "CI/CD", tags: ["ci/cd"], restsOn: [{ factId: "grad-4", relation: "supports" }], fromTerms: ["Jenkins"], rationale: "Jenkins runs CI/CD." };

async function setup(prepare: (mock: ReturnType<typeof testMock>) => void = () => {}) {
  const mock = testMock();
  prepare(mock);
  const data = createMasterCvData(mock, { pollMs: 5 });
  const page = await readMasterCvPage(data);
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <MasterCvScreen initial={page.read} initialVersions={page.versions} initialRequests={page.requests} initialDerived={page.derived} data={data} />
    </ToastProvider>,
  );
  return { user, data, mock };
}

const cvOf = (mock: ReturnType<typeof testMock>): MasterCv => {
  if (mock.state.masterCv.kind !== "ok") throw new Error("no master CV");
  return mock.state.masterCv.cv;
};

beforeEach(() => window.localStorage.clear());

describe("derived facts on the Master CV screen", () => {
  it("REQ-19.AC-1 / AC-2: a derived fact reads 'Added automatically' with 'Rests on' or 'Implied from' links that focus the cited fact", async () => {
    const { user } = await setup((m) => void mockDeriveFacts(m, [redux, cicd], { jobId: "101", company: "NovaPay" }));
    const derived = screen.getAllByTestId("fact").filter((f) => f.dataset.derived);
    expect(derived.map((f) => f.dataset.factId)).toEqual(["apc-d1", "grad-d1"]);
    const reduxCard = derived[0]!;
    expect(reduxCard).toHaveTextContent("Apps Cyclone · skill · Sep 2022 – Jan 2024");
    expect(within(reduxCard).getByTestId("fact-provenance")).toHaveTextContent("Added automaticallyImplied from apc-1");
    expect(within(derived[1]!).getByTestId("fact-provenance")).toHaveTextContent("Rests on grad-4");
    // Ba's own facts carry no label.
    expect(within(screen.getAllByTestId("fact")[0]!).queryByTestId("fact-provenance")).toBeNull();
    await user.click(within(reduxCard).getByRole("button", { name: "apc-1" }));
    expect(document.activeElement).toBe(screen.getAllByTestId("fact").find((f) => f.dataset.factId === "apc-1"));
    // "Why" shows the rationale as plain text.
    expect(within(reduxCard).getByText("Why")).toBeInTheDocument();
    expect(within(reduxCard).getByText("Redux is the common state library for React and Next.js apps.")).toBeInTheDocument();
  });

  it("editing a derived fact keeps its label, and shows its sources read-only", async () => {
    const { user } = await setup((m) => void mockDeriveFacts(m, [redux]));
    await user.click(screen.getByRole("button", { name: "Edit apc-d1" }));
    expect(within(screen.getByTestId("fact-editor")).getByTestId("fact-provenance-readonly")).toHaveTextContent("Added automaticallyImplied from apc-1 (sources can't be edited)");
    await user.click(within(screen.getByTestId("fact-editor")).getByRole("button", { name: "Done" }));
    expect(within(screen.getAllByTestId("fact").find((f) => f.dataset.factId === "apc-d1")!).getByTestId("fact-provenance")).toHaveTextContent("Added automatically");
  });

  it("REQ-18 / REQ-26.AC-4: the undo bar names the change; Undo on the latest change goes back to the version before", async () => {
    const { user, mock } = await setup((m) => void mockDeriveFacts(m, [redux, cicd]));
    const bar = screen.getByTestId("derived-undo-bar");
    expect(bar).toHaveTextContent("Added 2 facts automatically (change 8).");
    expect(within(bar).getByText("apc-d1")).toBeInTheDocument();
    await user.click(within(bar).getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Undone: back to change 7.")).toBeInTheDocument();
    expect(screen.queryByTestId("derived-undo-bar")).toBeNull();
    expect(screen.getAllByTestId("fact").map((f) => f.dataset.factId)).toEqual(MASTER_CV.facts.map((f) => f.id));
    expect(cvOf(mock).facts).toEqual(MASTER_CV.facts);
    expect(screen.getByTestId("cv-header")).toHaveTextContent("Master version v9.");
  });

  it("Undo when other changes came after removes only those facts", async () => {
    const { user, mock } = await setup((m) => {
      mockDeriveFacts(m, [redux]);
      mockDeriveFacts(m, [cicd]);
    });
    const bars = screen.getAllByTestId("derived-undo-bar");
    expect(bars.map((b) => b.dataset.version)).toEqual(["9", "8"]);
    await user.click(within(bars[1]!).getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Removed Redux (change 10).")).toBeInTheDocument();
    expect(cvOf(mock).facts.map((f) => f.id)).toEqual([...MASTER_CV.facts.map((f) => f.id), "grad-d1"]);
  });

  it("shows at most 3 bars, then 'and N more in the history'; and none for additions Ba has seen", async () => {
    const skills = ["Redux", "HTML", "CSS", "Zustand"];
    const { mock } = await setup((m) => {
      for (const s of skills) mockDeriveFacts(m, [{ ...redux, requirement: s, text: s, textVi: s, tags: [s.toLowerCase()] }]);
    });
    expect(screen.getAllByTestId("derived-undo-bar")).toHaveLength(3);
    expect(screen.getByTestId("derived-more")).toHaveTextContent("and 1 more in the history");
    // Next visit: nothing new since.
    document.body.innerHTML = "";
    const data = createMasterCvData(mock, { pollMs: 5 });
    const page = await readMasterCvPage(data);
    render(
      <ToastProvider>
        <MasterCvScreen initial={page.read} initialVersions={page.versions} initialRequests={page.requests} initialDerived={page.derived} data={data} />
      </ToastProvider>,
    );
    expect(screen.queryByTestId("derived-undo-bar")).toBeNull();
  });

  it("REQ-20: a fact whose source changed is flagged, with Keep and Delete; Keep makes it active again", async () => {
    const { user, mock } = await setup((m) => {
      mockDeriveFacts(m, [redux]);
      const cv = cvOf(m);
      m.state.masterCv = { kind: "ok", cv: { ...cv, version: cv.version + 1, facts: cv.facts.map((f) => (f.id === "apc-1" ? { ...f, text: "Role-based education portal in Vue" } : f)) } };
    });
    const card = screen.getAllByTestId("fact").find((f) => f.dataset.factId === "apc-d1")!;
    expect(card.dataset.derived).toBe("stale");
    expect(within(card).getByTestId("fact-source-changed")).toHaveTextContent("Source fact changedNot used in new tailor tasks until you keep or delete it.");
    await user.click(within(card).getByRole("button", { name: "Keep" }));
    expect(await screen.findByText("Kept apc-d1: it rests on its facts as they are now (change 10).")).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByTestId("fact").find((f) => f.dataset.factId === "apc-d1")!.dataset.derived).toBe("active"));
    expect(screen.queryByTestId("fact-source-changed")).toBeNull();
    expect(cvOf(mock).version).toBe(10);
  });

  it("Delete on a flagged fact removes it from the list (saved with Save)", async () => {
    const { user } = await setup((m) => {
      mockDeriveFacts(m, [redux]);
      const cv = cvOf(m);
      m.state.masterCv = { kind: "ok", cv: { ...cv, version: cv.version + 1, facts: cv.facts.filter((f) => f.id !== "apc-1") } };
    });
    const card = screen.getAllByTestId("fact").find((f) => f.dataset.factId === "apc-d1")!;
    await user.click(within(within(card).getByTestId("fact-source-changed")).getByRole("button", { name: "Delete" }));
    expect(screen.getAllByTestId("fact").some((f) => f.dataset.factId === "apc-d1")).toBe(false);
    expect(screen.getByText("unsaved changes")).toBeInTheDocument();
  });

  it("REQ-27 / REQ-28: 'Not added (n)' is collapsed and lists what the checks refused, with why", async () => {
    const { user } = await setup((m) => {
      mockDeriveFacts(m, [{ ...cicd, type: "experience", text: "CI/CD with Jenkins for 10 services", textVi: null }, { ...redux, type: "experience", text: "Tech Lead for the Next.js portal", textVi: null }]);
    });
    const region = screen.getByTestId("derived-not-added");
    const toggle = within(region).getByRole("button", { name: /Not added \(2\)/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(region).queryByText(/says 10/)).toBeNull();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(region).toHaveTextContent("“CI/CD with Jenkins for 10 services” · Cites grad-4");
    expect(region).toHaveTextContent("Not added: says 10, which grad-4 does not say.");
    expect(region).toHaveTextContent("Not added: names the title lead, which apc-1 does not say.");
    // Nothing can be accepted from here.
    expect(within(region).getAllByRole("button")).toEqual([toggle]);
    expect(screen.queryByTestId("derived-undo-bar")).toBeNull();
  });

  it("no automatic additions: no bar and no region; the page is as before", async () => {
    await setup();
    expect(screen.queryByTestId("derived-undo-bar")).toBeNull();
    expect(screen.queryByTestId("derived-not-added")).toBeNull();
    expect(screen.getAllByTestId("fact").every((f) => !f.dataset.derived)).toBe(true);
  });
});
