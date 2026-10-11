import { BotViewSchema, WorkflowProposalSchema } from "@bs-job-agents/shared";
import { describe, expect, it } from "vitest";
import { apiErrorInfo } from "@/components/schedules/apiError";
import { seedBotViews } from "@/lib/api/mock/seed-bots";
import { testMock } from "@/lib/api/mock/testing";
import { createBotsData } from "./data";

const make = () => createBotsData(testMock());
const err = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => apiErrorInfo(e));

describe("seeded bots (mock orchestrator)", () => {
  it("are valid BotViews for the five Phase 1 bots, with memory note ids", () => {
    const bots = seedBotViews();
    expect(bots.map((b) => b.name)).toEqual(["lead", "research", "cv", "qa", "apply"]);
    for (const b of bots) expect(() => BotViewSchema.parse(b)).not.toThrow();
    expect(bots.every((b) => b.memoryNotes?.length === b.memory.length)).toBe(true);
  });

  it("match the prototype: Apply L1 with a promotion it can't accept, CV demoted, Research with its residual risk", async () => {
    const bots = await make().list();
    expect(bots.find((b) => b.name === "apply")).toMatchObject({ trustLevel: 1, engine: "claude", promotionSuggested: true, promoteAllowed: false });
    expect(bots.find((b) => b.name === "cv")).toMatchObject({ trustLevel: 1, demotion: { fromLevel: 2 } });
    expect(bots.find((b) => b.name === "research")!.residualRisk).toMatch(/prompt/);
  });
});

describe("bots adapter (PM S21 rules)", () => {
  it("reads one bot, and maps 404 to null", async () => {
    const data = make();
    expect((await data.get("qa"))?.displayName).toBe("QA");
    expect(await data.get("nope")).toBeNull();
  });

  it("switches an unlocked bot's engine", async () => {
    expect((await make().update("research", { engine: "claude" })).engine).toBe("claude");
  });

  it("refuses Apply or CV on Codex with the API's 403 (checkBotSafety)", async () => {
    const data = make();
    expect(await err(data.update("apply", { engine: "codex" }))).toMatchObject({ status: 403, code: "forbidden", message: expect.stringMatching(/browser bot/) });
    expect(await err(data.update("cv", { engine: "codex" }))).toMatchObject({ status: 403, message: expect.stringMatching(/Figma/) });
    expect(await err(data.update("lead", { engine: "codex" }))).toMatchObject({ status: 403, message: expect.stringMatching(/Lead must run on Claude/) });
  });

  it("raises one level at a time up to the Phase 1 cap; Apply stays L1 (403); lowering is allowed", async () => {
    const data = make();
    expect(await err(data.update("apply", { trustLevel: 2 }))).toMatchObject({ status: 403, message: expect.stringMatching(/Apply stays at L1/) });
    expect((await data.update("lead", { trustLevel: 2 })).trustLevel).toBe(2);
    expect(await data.update("lead", { trustLevel: 0 })).toMatchObject({ trustLevel: 0, promoteAllowed: true });
    expect(await err(data.update("lead", { trustLevel: 2 }))).toMatchObject({ status: 403, message: expect.stringMatching(/one step at a time/) });
    expect(await err(data.update("lead", { model: "x" } as never))).toMatchObject({ status: 400, code: "validation_failed" });
  });

  it("restores a demoted bot and clears the demotion", async () => {
    expect(await make().update("cv", { trustLevel: 2 })).toMatchObject({ trustLevel: 2, demotion: null });
  });

  it("deletes a memory note by id (404 once gone) and dismisses a suggestion (409 when there is none)", async () => {
    const data = make();
    const lead = (await data.get("lead"))!;
    const note = lead.memoryNotes!.find((n) => n.text === "Ask one question max before starting a scan.")!;
    const after = await data.deleteMemoryNote("lead", note.id);
    expect(after.memory).toEqual(["Ba prefers product companies over outsourcing."]);
    expect(after.memoryNotes!.map((n) => n.id)).not.toContain(note.id);
    expect(await err(data.deleteMemoryNote("lead", note.id))).toMatchObject({ status: 404 });
    expect((await data.dismissPromotion("apply")).promotionSuggested).toBe(false);
    expect(await err(data.dismissPromotion("apply"))).toMatchObject({ status: 409 });
  });
});

describe("workflow proposals (rule 3)", () => {
  it("lists Lead's proposals; approving saves a version and starts nothing; a decided one is 409", async () => {
    const mock = testMock();
    const data = createBotsData(mock);
    const [p] = await data.proposals();
    expect(WorkflowProposalSchema.parse(p)).toMatchObject({ status: "pending", basedOn: "job-scan" });
    const runs = Object.keys(mock.state.runs).length;
    const res = await data.approveProposal(p!.id);
    expect(res).toMatchObject({ proposal: { status: "approved", savedVersion: 1 }, workflow: { name: p!.name, version: 1 } });
    expect(Object.keys(mock.state.runs)).toHaveLength(runs);
    expect(await err(data.dismissProposal(p!.id))).toMatchObject({ status: 409 });
  });

  it("dismisses a new proposal from Lead (simulated)", async () => {
    const mock = testMock();
    mock.simulate("workflow-proposal");
    await mock.idle();
    const data = createBotsData(mock);
    const [newest] = await data.proposals();
    expect(newest).toMatchObject({ status: "pending", name: "scan-da-nang-2" });
    expect((await data.dismissProposal(newest!.id)).status).toBe("dismissed");
    expect(await err(data.approveProposal("00000000-0000-0000-0000-000000000000"))).toMatchObject({ status: 404 });
  });
});
