import type { AppEvent, Message, Step, Task } from "@bs-job-agents/shared";
import { messageFixture, runFixture, stepFixture, taskFixture } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import type { RunView } from "@/lib/api/runs";
import {
  delegationRows,
  isLatestQuestion,
  mergeMessages,
  parseRichText,
  pauseCopy,
  questionPlaceholder,
  taskPhaseOf,
  toolStepText,
  workingReducer,
  type WorkingTasks,
} from "./model";

const msg = (id: string, createdAt: string, over: Partial<Message> = {}): Message => ({ ...messageFixture, id, createdAt, cards: [], ...over });

describe("the working indicator follows the conversation task (PM3 S5)", () => {
  const ev = (e: Record<string, unknown>) => ({ id: "1", at: "2026-10-11T03:00:00Z", runId: null, stepId: null, ...e }) as unknown as AppEvent;
  const lead = { botName: "lead", kind: "chat" };

  it("Lead's tool calls become one-line steps", () => {
    expect(toolStepText("mcp__orchestrator__start_workflow", '{"workflow":"job-scan","params":{"searchProfileId":null}}')).toBe("Starting job-scan…");
    expect(toolStepText("mcp__orchestrator__start_workflow", '{"workflow":"danang-react","params":{}}')).toBe("Starting danang-react…");
    expect(toolStepText("mcp__orchestrator__get_status", '{"runId":"13"}')).toBe("Checking run 13…");
    expect(toolStepText("mcp__orchestrator__get_status", null)).toBe("Checking the status…");
    expect(toolStepText("mcp__orchestrator__get_result", '{"taskId":"7"}')).toBe("Reading the result of task 7…");
    expect(toolStepText("mcp__orchestrator__create_task", '{"bot":"research","kind":"company"}')).toBe("Asking Research (company)…");
    expect(toolStepText("mcp__orchestrator__message_user", "On it")).toBe("Writing to you…");
    expect(toolStepText("mcp__orchestrator__propose_workflow", "{}")).toBe("Proposing a workflow…");
    expect(toolStepText("WebSearch", "react jobs")).toBe("WebSearch: react jobs");
  });

  it("starts on task.started, gathers tool steps, ends on task.finished; other bots and kinds are ignored", () => {
    let w: WorkingTasks = {};
    w = workingReducer(w, ev({ type: "task.started", taskId: "5", botName: "lead", kind: "chat", engine: "claude", attempt: 1 }), lead);
    expect(w).toEqual({ "5": [] });
    w = workingReducer(w, ev({ type: "task.started", taskId: "6", botName: "research", kind: "scan", engine: "claude", attempt: 1 }), lead);
    w = workingReducer(w, ev({ type: "task.progress", taskId: "5", botName: "lead", kind: "status", text: "Lead started on claude", tool: null }), lead);
    w = workingReducer(w, ev({ type: "task.progress", taskId: "5", botName: "lead", kind: "tool_use", text: '{"workflow":"job-scan"}', tool: "mcp__orchestrator__start_workflow" }), lead);
    w = workingReducer(w, ev({ type: "task.progress", taskId: "5", botName: "lead", kind: "tool_result", text: "ok", tool: "mcp__orchestrator__start_workflow" }), lead);
    w = workingReducer(w, ev({ type: "task.progress", taskId: "6", botName: "research", kind: "tool_use", text: "x", tool: "navigate" }), lead);
    expect(w).toEqual({ "5": ["Starting job-scan…"] });
    w = workingReducer(w, ev({ type: "task.finished", taskId: "5", botName: "lead", status: "done", attempt: 1, error: null }), lead);
    expect(w).toEqual({});
  });
});

describe("mergeMessages", () => {
  it("de-duplicates by id (POST answer and SSE event) and keeps time order", () => {
    const a = msg("1", "2026-10-10T09:00:00Z");
    const b = msg("2", "2026-10-10T09:01:00Z");
    const b2 = { ...b, text: "edited" };
    const c = msg("3", "2026-10-10T08:59:00Z");
    expect(mergeMessages([a, b], [b2, c]).map((m) => [m.id, m.text === "edited"])).toEqual([
      ["3", false],
      ["1", false],
      ["2", true],
    ]);
  });
  it("orders same-second messages by numeric id", () => {
    expect(mergeMessages([msg("10", "2026-10-10T09:00:00Z")], [msg("9", "2026-10-10T09:00:00Z")]).map((m) => m.id)).toEqual(["9", "10"]);
  });
});

describe("parseRichText", () => {
  it("turns **bold** into bold segments and leaves the rest as text", () => {
    expect(parseRichText("Started **Job scan #13** using v3.")).toEqual([
      { bold: false, text: "Started " },
      { bold: true, text: "Job scan #13" },
      { bold: false, text: " using v3." },
    ]);
    expect(parseRichText("no markup <b>raw</b>")).toEqual([{ bold: false, text: "no markup <b>raw</b>" }]);
    expect(parseRichText("**unclosed")).toEqual([{ bold: false, text: "**unclosed" }]);
  });
});

describe("question cards (UC-12)", () => {
  it("only the newest question card of a task is live", () => {
    const q = (id: string, field: string): Message =>
      msg(id, `2026-10-10T09:0${id}:00Z`, {
        cards: [{ type: "question", applicationId: "a", taskId: "t1", question: { field, label: field, required: false, kind: "text", options: null }, answered: false }],
      });
    const list = [q("1", "salary"), q("2", "start")];
    expect(isLatestQuestion(list, "t1", "salary")).toBe(false);
    expect(isLatestQuestion(list, "t1", "start")).toBe(true);
  });

  it("task events say whether a task still waits", () => {
    expect(taskPhaseOf({ id: "1", at: "2026-10-10T09:00:00Z", type: "task.resumed", taskId: "t1", runId: null, botName: "apply" })).toEqual(["t1", "running"]);
    expect(
      taskPhaseOf({ id: "2", at: "2026-10-10T09:00:00Z", type: "task.finished", taskId: "t1", runId: null, stepId: null, botName: "apply", status: "failed", attempt: 1, error: null }),
    ).toEqual(["t1", "ended"]);
    expect(
      taskPhaseOf({ id: "3", at: "2026-10-10T09:00:00Z", type: "task.paused", taskId: "t1", runId: null, botName: "apply", reason: { code: "needs_answer", site: null, detail: null } }),
    ).toEqual(["t1", "paused"]);
    expect(taskPhaseOf({ id: "4", at: "2026-10-10T09:00:00Z", type: "engine.resumed", engine: "claude" })).toBeNull();
  });

  it("placeholders follow the field kind", () => {
    expect(questionPlaceholder("salary")).toBe("e.g. 32,000,000");
    expect(questionPlaceholder("date")).toBe("e.g. 2 weeks after offer");
    expect(questionPlaceholder("text")).toBe("Type your answer");
  });
});

describe("pauseCopy (UC-17, UC-11 e; PM S24 wording)", () => {
  it("domain confirm names the host and asks to allow it for this application", () => {
    const c = pauseCopy("domain_confirm(acme.wd3.myworkdayjobs.com)", "Apply");
    expect(c.body).toBe("Apply tried to open acme.wd3.myworkdayjobs.com, which is not the employer's job site. Allow it for this application?");
    expect(c.host).toBe("acme.wd3.myworkdayjobs.com");
    expect(c.action).toEqual({ label: "Allow acme.wd3.myworkdayjobs.com", confirmDomain: "acme.wd3.myworkdayjobs.com" });
  });
  it("login and CAPTCHA ask Ba to fix it in Chrome, then click Done", () => {
    const login = pauseCopy("needs_login(linkedin.com)", "Research");
    expect(login.title).toBe("Log in to linkedin.com");
    expect(login.body).toMatch(/Research's tab group/);
    expect(login.action).toEqual({ label: "Done — I'm logged in", confirmDomain: null });
    expect(pauseCopy("captcha(topcv.vn)", null).action?.label).toBe("Done — solved");
  });
  it("Figma, Chrome and usage pauses continue by themselves (no Done)", () => {
    expect(pauseCopy("needs_figma", "CV")).toMatchObject({ action: null });
    expect(pauseCopy("needs_figma", "CV").body).toMatch(/Figma Desktop Bridge/);
    expect(pauseCopy("needs_browser", null)).toMatchObject({ action: null });
    expect(pauseCopy("usage_limit", null)).toMatchObject({ action: null });
  });
  it("an unparseable reason still renders", () => {
    expect(pauseCopy("weird thing", null).title).toBe("Paused");
  });
});

describe("delegationRows (Lead → @Bot: task · status)", () => {
  const step = (stepKey: string, branchKey: string | null, status: Step["status"], preview: string | null = null) => ({
    ...stepFixture,
    id: `${stepKey}-${branchKey}`,
    stepKey,
    branchKey,
    status,
    preview,
  });
  const task = (botName: string, status: Task["status"], stepId: string): Task => ({ ...taskFixture, id: `${botName}-${stepId}-${status}`, botName, status, stepId });

  it("job scan: scan, fit, company, CV and QA rows with live status and detail", () => {
    const view: RunView = {
      run: runFixture,
      steps: [
        step("scan", null, "done", "34 found → 21 new"),
        step("dedupe", null, "done"),
        step("fit", null, "done", "21 done, 0 failed"),
        step("top", null, "done", "3 jobs ≥ 60"),
        step("company", "1", "done"),
        step("company", "2", "running"),
        step("tailor", "1:en", "running", "CV EN round 2"),
      ],
      tasks: [task("cv", "running", "tailor-1:en"), task("qa", "done", "tailor-1:en")],
    };
    const rows = delegationRows(view);
    expect(rows.map((r) => [r.bot, r.label, r.status])).toEqual([
      ["research", "Scan sources", "done"],
      ["research", "Dedupe + fit score", "done"],
      ["research", "Company profile", "running"],
      ["cv", "Tailor CV", "running"],
      ["qa", "QA score vs JD", "done"],
    ]);
    expect(rows[0]!.detail).toBe("34 found → 21 new");
    expect(rows[1]!.detail).toBe("3 jobs ≥ 60");
    expect(rows[2]!.detail).toBe("1/2 profiles");
  });

  it("adds Apply once it has started, and shows waiting for the usage limit", () => {
    const view: RunView = {
      run: runFixture,
      steps: [step("scan", null, "done"), step("apply", "1", "running", "queued")],
      tasks: [task("apply", "waiting_limit", "apply-1")],
    };
    const apply = delegationRows(view).find((r) => r.bot === "apply")!;
    expect(apply).toMatchObject({ label: "Fill & submit", status: "waiting_limit", detail: "queued" });
  });

  it("apply-to-link reads the job page instead of scanning sources", () => {
    const view: RunView = { run: { ...runFixture, workflowName: "apply-to-link" }, steps: [step("scan", null, "running")], tasks: [] };
    expect(delegationRows(view)[0]).toMatchObject({ label: "Read the job page", status: "running" });
  });
});
