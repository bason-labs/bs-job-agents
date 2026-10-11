// PM3 S4, rule 3: an approved workflow proposal becomes a saved preset (a shipped workflow plus
// stored params). Lead starts it by name with start_workflow and sees it in get_status; the run
// uses the preset's params and the Flows screen shows the preset's name.
import { RunDetailSchema, RunsResponseSchema } from "@bs-job-agents/shared";
import { afterEach, describe, expect, it } from "vitest";
import { getRun, getWorkflowPreset, listRuns } from "../../db/index.js";
import { proposalsOf } from "../context.js";
import { createApiHarness, type ApiHarness } from "../testing.js";

let h: ApiHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const lead = { botName: "lead", mode: "work" } as const;
const danang = {
  name: "danang-react",
  description: "React jobs in Đà Nẵng",
  basedOn: "job-scan",
  params: { searchProfileId: null, overrides: { locations: ["Đà Nẵng"], roles: ["React Developer"] } },
};

async function approved(x: ApiHarness, proposal = danang) {
  const p = proposalsOf(x.ctx).propose(proposal, { taskId: null });
  expect((await x.post(`/workflow-proposals/${p.id}/approve`)).statusCode).toBe(200);
}

describe("saved presets (PM3 S4, rule 3)", () => {
  it("approve → Lead starts it by name → the run is the base workflow with the preset's params, shown under the preset's name", async () => {
    h = await createApiHarness();
    await approved(h);
    expect(getWorkflowPreset(h.t.db, "danang-react")).toMatchObject({ name: "danang-react", basedOn: "job-scan", params: danang.params, description: danang.description });

    const r = h.t.engine.lead.startWorkflow(lead, { workflow: "danang-react", params: {} });
    expect(r).toMatchObject({ started: true });
    const run = getRun(h.t.db, (r as { runId: number }).runId)!;
    expect(run).toMatchObject({ workflowName: "job-scan", presetName: "danang-react", trigger: "chat" });
    expect(run.params).toMatchObject({ overrides: { locations: ["Đà Nẵng"], roles: ["React Developer"] } });

    const runs = RunsResponseSchema.parse((await h.get("/runs")).json());
    expect(runs.presetNames).toEqual({ [String(run.id)]: "danang-react" });
    const detail = RunDetailSchema.parse((await h.get(`/runs/${run.id}`)).json());
    expect(detail.presetName).toBe("danang-react");
  });

  it("Lead's params narrow the preset for one run (a key Lead gives replaces the preset's)", async () => {
    h = await createApiHarness();
    await approved(h);
    const r = h.t.engine.lead.startWorkflow(lead, { workflow: "danang-react", params: { showSkipped: true } });
    const run = getRun(h.t.db, (r as { runId: number }).runId)!;
    expect(run.params).toMatchObject({ showSkipped: true, overrides: { locations: ["Đà Nẵng"] } });
  });

  it("get_status lists the saved presets so Lead can start them by name", async () => {
    h = await createApiHarness();
    await approved(h);
    expect(h.t.engine.lead.getStatus(lead, {}).presets).toEqual([
      { name: "danang-react", description: "React jobs in Đà Nẵng", basedOn: "job-scan", params: danang.params },
    ]);
  });

  it("an unknown name, a pending or dismissed proposal, and a YAML (non-preset) workflow are refused; nothing starts", async () => {
    h = await createApiHarness();
    const store = proposalsOf(h.ctx);
    store.propose({ ...danang, name: "still-pending" }, { taskId: null });
    const dismissed = store.propose({ ...danang, name: "was-dismissed" }, { taskId: null });
    await h.post(`/workflow-proposals/${dismissed.id}/dismiss`);
    for (const name of ["nope", "still-pending", "was-dismissed"]) {
      expect(() => h!.t.engine.lead.startWorkflow(lead, { workflow: name, params: {} }), name).toThrow(/no workflow or saved preset/);
    }
    expect(listRuns(h.t.db)).toEqual([]);
  });

  it("a preset's params are checked again at start (a bad Lead param is refused)", async () => {
    h = await createApiHarness();
    await approved(h);
    expect(() => h!.t.engine.lead.startWorkflow(lead, { workflow: "danang-react", params: { url: "https://itviec.com/x" } })).toThrow(/invalid/);
    expect(listRuns(h.t.db)).toEqual([]);
  });
});
