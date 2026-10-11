// Rule 3 / PM S22: Lead proposes, Ba approves (saved as a workflows row, never run) or dismisses.
import { WorkflowProposalApproveResponseSchema, WorkflowProposalSchema, WorkflowProposalsResponseSchema } from "@bs-job-agents/shared";
import { afterEach, describe, expect, it } from "vitest";
import { getWorkflow, listRuns } from "../../db/index.js";
import { proposalsOf } from "../context.js";
import { parseWorkflowYaml } from "../boot/workflows.js";
import { createApiHarness, type ApiHarness } from "../testing.js";

let h: ApiHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const preset = { name: "weekly-hcm-react", description: "React jobs in HCM", basedOn: "job-scan", params: { searchProfileId: null, overrides: null } };

const CUSTOM_YAML = `name: research-only
version: 7
description: Scan one link, no CV
triggers: [chat]
steps:
  - key: scan
    type: task
    task:
      bot: research
      kind: single
      input:
        url: $params.url
`;

describe("workflow proposals", () => {
  it("lists proposals newest first; approving a preset saves the next version and starts nothing", async () => {
    h = await createApiHarness();
    const store = proposalsOf(h.ctx);
    const first = store.propose(preset, { taskId: 3 });
    store.propose({ ...preset, name: "second-one" }, { taskId: null });
    const list = WorkflowProposalsResponseSchema.parse((await h.get("/workflow-proposals")).json()).proposals;
    expect(list.map((p) => p.name)).toEqual(["second-one", "weekly-hcm-react"]);
    expect(list[1]).toMatchObject({ status: "pending", taskId: "3", savedVersion: null });

    const res = await h.post(`/workflow-proposals/${first.id}/approve`);
    expect(res.statusCode).toBe(200);
    const body = WorkflowProposalApproveResponseSchema.parse(res.json());
    expect(body.workflow).toEqual({ name: "weekly-hcm-react", version: 1 });
    expect(body.proposal).toMatchObject({ status: "approved", savedVersion: 1 });
    const row = getWorkflow(h.t.db, "weekly-hcm-react", 1)!;
    expect(row.definitionYaml).toMatch(/preset params: \{"searchProfileId":null,"overrides":null\}/);
    expect(parseWorkflowYaml(row.definitionYaml, "saved")).toMatchObject({ name: "weekly-hcm-react", version: 1, description: "React jobs in HCM" });
    expect(listRuns(h.t.db)).toEqual([]);
    // Decided once.
    expect((await h.post(`/workflow-proposals/${first.id}/approve`)).statusCode).toBe(409);
    expect((await h.post(`/workflow-proposals/${first.id}/dismiss`)).statusCode).toBe(409);
  });

  it("a YAML proposal is validated and saved under the next version (its own version number is ignored)", async () => {
    h = await createApiHarness();
    const store = proposalsOf(h.ctx);
    const p = store.propose({ name: "research-only", description: "Scan one link", definitionYaml: CUSTOM_YAML }, { taskId: null });
    const body = WorkflowProposalApproveResponseSchema.parse((await h.post(`/workflow-proposals/${p.id}/approve`)).json());
    expect(body.workflow).toEqual({ name: "research-only", version: 1 });
    const again = store.propose({ name: "research-only", description: "v2", definitionYaml: CUSTOM_YAML }, { taskId: null });
    expect(WorkflowProposalApproveResponseSchema.parse((await h.post(`/workflow-proposals/${again.id}/approve`)).json()).workflow.version).toBe(2);
  });

  it("refuses an invalid proposal: a shipped name, an outward-facing task outside an action step, a name mismatch, bad params", async () => {
    h = await createApiHarness();
    const store = proposalsOf(h.ctx);
    expect(() => store.propose({ ...preset, name: "job-scan" }, { taskId: null })).toThrow(/shipped workflow/);
    const outward = CUSTOM_YAML.replace("bot: research\n      kind: single", "bot: apply\n      kind: submit");
    expect(() => store.propose({ name: "research-only", description: "x", definitionYaml: outward }, { taskId: null })).toThrow(/outward-facing/);
    expect(() => store.propose({ name: "other-name", description: "x", definitionYaml: CUSTOM_YAML }, { taskId: null })).toThrow(/named research-only/);
    expect(() => store.propose({ ...preset, params: { url: 5 } }, { taskId: null })).toThrow(/params/);
    expect(() => store.propose({ name: "x", description: "x" }, { taskId: null })).toThrow(/basedOn/);
    expect(store.list()).toEqual([]);
  });

  it("dismiss marks it and saves nothing; unknown ids are 404", async () => {
    h = await createApiHarness();
    const p = proposalsOf(h.ctx).propose(preset, { taskId: null });
    const res = await h.post(`/workflow-proposals/${p.id}/dismiss`);
    expect(WorkflowProposalSchema.parse(res.json())).toMatchObject({ status: "dismissed" });
    expect(getWorkflow(h.t.db, "weekly-hcm-react")).toBeUndefined();
    expect((await h.post("/workflow-proposals/00000000-0000-4000-8000-000000000000/approve")).statusCode).toBe(404);
    expect((await h.post("/workflow-proposals/../../etc/approve")).statusCode).toBe(404);
  });

  it("approving needs the CSRF header like every state change (S18)", async () => {
    h = await createApiHarness();
    const p = proposalsOf(h.ctx).propose(preset, { taskId: null });
    const res = await h.app.inject({ method: "POST", url: `/workflow-proposals/${p.id}/approve`, headers: { host: "127.0.0.1:4100" } });
    expect(res.statusCode).toBe(403);
    expect(getWorkflow(h.t.db, "weekly-hcm-react")).toBeUndefined();
  });
});
