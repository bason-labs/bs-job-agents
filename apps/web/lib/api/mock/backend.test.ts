import {
  AnswerQuestionResponseSchema,
  AppEventSchema,
  ApproveResponseSchema,
  BotsResponseSchema,
  RunControlResponseSchema,
  StepDetailSchema,
  TranscriptLineSchema,
  ChatSendResponseSchema,
  EnginesResponseSchema,
  MessagesResponseSchema,
  ReviewQueueResponseSchema,
  RoomsResponseSchema,
  RunDetailSchema,
  RunsResponseSchema,
  UploadsResponseSchema,
  type AppEvent,
  type Message,
  type MessageCard,
} from "@bs-job-agents/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isApiError } from "../errors";
import { MockBackend } from "./backend";
import { LEAD_ROOM_ID, directRoomId } from "./seed";

let api: MockBackend;
let events: AppEvent[];

beforeEach(() => {
  api = new MockBackend({ sleep: () => Promise.resolve() });
  events = [];
  api.subscribe((e) => events.push(e));
});

afterEach(() => {
  // Every event the mock emits is a valid shared AppEvent, ids strictly increasing (SSE replay order).
  for (const e of events) expect(AppEventSchema.safeParse(e).success, `${e.type} ${JSON.stringify(e).slice(0, 200)}`).toBe(true);
  const ids = events.map((e) => Number(e.id));
  expect(ids).toEqual([...ids].sort((a, b) => a - b));
  expect(new Set(ids).size).toBe(ids.length);
});

const leadMessages = async () => (await api.listMessages(LEAD_ROOM_ID, { limit: 200 })).messages;
const cardsOf = <T extends MessageCard["type"]>(messages: Message[], type: T) =>
  messages.flatMap((m) => m.cards).filter((c): c is Extract<MessageCard, { type: T }> => c.type === type);
const errorOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

describe("mock backend: parity with the shared API schemas", () => {
  it("every read parses with the shared response schema", async () => {
    expect(BotsResponseSchema.safeParse({ bots: await api.listBots() }).success).toBe(true);
    expect(EnginesResponseSchema.safeParse({ engines: await api.listEngines() }).success).toBe(true);
    expect(RoomsResponseSchema.safeParse({ rooms: await api.listRooms() }).success).toBe(true);
    expect(MessagesResponseSchema.safeParse(await api.listMessages(LEAD_ROOM_ID)).success).toBe(true);
    expect(MessagesResponseSchema.safeParse(await api.listMessages("cv-brainstorm")).success).toBe(true);
    expect(ReviewQueueResponseSchema.safeParse({ cards: await api.getReviewQueue() }).success).toBe(true);
    expect(RunsResponseSchema.safeParse({ runs: await api.listRuns() }).success).toBe(true);
    for (const run of await api.listRuns()) {
      const parsed = RunDetailSchema.safeParse(await api.getRun(run.id));
      expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true);
    }
    const detail = await api.getRun("12");
    const lines = await api.getTranscript(detail.tasks[0]!.id);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(TranscriptLineSchema.safeParse(line).success).toBe(true);
    const step = await api.getStep(detail.steps[0]!.id);
    expect(StepDetailSchema.safeParse(step).success).toBe(true);
    expect(step.selfCheck.map((c) => c.item)).toContain("Every job has a reachable URL");
    expect(step.durationMs).toBe(6 * 60_000 + 35_000);
  });

  it("filters runs like RunsQuery (status, limit)", async () => {
    expect((await api.listRuns()).map((r) => r.id)).toEqual(["12", "11"]);
    expect((await api.listRuns({ status: "done" })).map((r) => r.id)).toEqual(["11"]);
    expect((await api.listRuns({ limit: 1 })).map((r) => r.id)).toEqual(["12"]);
  });

  it("seeds the prototype's demo: 3 cards waiting from Job scan #12, Lead and consult rooms", async () => {
    const shell = await api.getShellData();
    expect(shell.reviewCount).toBe(3);
    expect(shell.activeRunId).toBe("12");
    expect(shell.bots.map((b) => b.name)).toEqual(["lead", "research", "cv", "qa", "apply"]);
    expect(shell.rooms).toEqual([{ id: "cv-brainstorm", name: "cv-brainstorm" }]);
    const cards = await api.getReviewQueue();
    expect(cards.map((c) => [c.job.company, c.defaultLanguage, c.flags.escalated, c.flags.injectionFlagged])).toEqual([
      ["NovaPay", "en", false, false],
      ["Sao Việt Tech", "vi", false, false],
      ["Kite Labs", "en", true, true],
    ]);
    const rooms = await api.listRooms();
    expect(rooms.filter((r) => r.kind === "direct").map((r) => r.botName)).toEqual(["research", "cv", "qa", "apply"]);
  });

  it("pages messages with before/limit", async () => {
    const all = await api.listMessages(LEAD_ROOM_ID);
    const page = await api.listMessages(LEAD_ROOM_ID, { limit: 2 });
    expect(page.messages.map((m) => m.id)).toEqual(all.messages.slice(-2).map((m) => m.id));
    expect(page.hasMore).toBe(true);
    const older = await api.listMessages(LEAD_ROOM_ID, { before: page.messages[0]!.id, limit: 10 });
    expect(older.messages.map((m) => m.id)).toEqual(all.messages.slice(0, -2).map((m) => m.id));
    expect(older.hasMore).toBe(false);
  });
});

describe("mock backend: chat (UC-01, UC-24, UC-25)", () => {
  it("UC-01: a find request starts a job scan whose cards reach review; Lead streams its replies", async () => {
    const sent = await api.sendMessage({ roomId: LEAD_ROOM_ID, text: "Find frontend jobs in HCM, React/Next.js, ≥ 25M" });
    expect(ChatSendResponseSchema.safeParse({ message: sent }).success).toBe(true);
    await api.idle();
    const messages = await leadMessages();
    const runCards = cardsOf(messages, "run");
    expect(runCards.at(-1)!.runId).toBe("13");
    expect(messages.some((m) => m.text.includes("Started **Job scan #13**"))).toBe(true);
    expect(events.some((e) => e.type === "message.delta")).toBe(true);
    const detail = await api.getRun("13");
    expect(detail.run.status).toBe("waiting");
    expect(detail.steps.find((s) => s.stepKey === "scan")!.status).toBe("done");
    expect(events.filter((e) => e.type === "review.ready").map((e) => (e as Extract<AppEvent, { type: "review.ready" }>).company)).toEqual([
      "Lumen Health",
      "Orbit Logistics",
    ]);
    expect((await api.getReviewQueue()).length).toBe(5);
    expect(cardsOf(messages, "review_link").at(-1)!.count).toBe(5);
    expect(events.some((e) => e.type === "bot.updated" && e.botName === "research" && e.activity === "working")).toBe(true);
    // Orbit Logistics is a VI JD: one gate per language, `<jobId>:<lang>`.
    expect(detail.steps.filter((s) => s.stepKey === "tailor").map((s) => s.branchKey)).toEqual(expect.arrayContaining(["202:vi", "202:en"]));
  });

  it("a third scan finds no strong matches and finishes the run (UC-04 a)", async () => {
    for (let i = 0; i < 3; i++) {
      await api.sendMessage({ roomId: LEAD_ROOM_ID, text: "Find more jobs" });
      await api.idle();
    }
    const last = (await api.listRuns())[0]!;
    expect(last.status).toBe("done");
    expect((await leadMessages()).at(-1)!.text).toMatch(/No strong matches/);
  });

  it("UC-25: a work request in a consult chat is handed to Lead, who starts the work", async () => {
    await api.sendMessage({ roomId: directRoomId("research"), text: "Find more AI jobs for me" });
    await api.idle();
    const dm = (await api.listMessages(directRoomId("research"))).messages;
    expect(dm.at(-1)!.mode).toBe("consult");
    expect(cardsOf(dm, "handoff")).toEqual([{ type: "handoff", fromBot: "research", request: "Find more AI jobs for me" }]);
    const lead = await leadMessages();
    expect(lead.some((m) => m.text.startsWith("📨 Handed over from **@Research**"))).toBe(true);
    expect(cardsOf(lead, "run").at(-1)!.runId).toBe("13");
  });

  it("UC-25: a question in a consult chat gets an answer and no hand-off", async () => {
    await api.sendMessage({ roomId: directRoomId("qa"), text: "How do you score?" });
    await api.idle();
    const dm = (await api.listMessages(directRoomId("qa"))).messages;
    expect(dm.map((m) => m.author.type)).toEqual(["ba", "bot"]);
    expect(cardsOf(dm, "handoff")).toEqual([]);
    expect((await leadMessages()).length).toBe(4);
  });

  it("UC-21b a (PM3 M3): 'also include Đà Nẵng' proposes; Save writes v4 from the stored change, like the orchestrator", async () => {
    await api.sendMessage({ roomId: LEAD_ROOM_ID, text: "Also include Đà Nẵng" });
    await api.idle();
    const msg = (await leadMessages()).at(-1)!;
    expect(msg.text).toBe("Save to your search criteria (now v3)? Add Đà Nẵng to locations.");
    const card = msg.cards[0] as Extract<MessageCard, { type: "choice" }>;
    expect(card).toMatchObject({ type: "choice", key: expect.stringMatching(/^criteria-save:[A-Za-z0-9_-]{12,}$/), chosen: null });
    expect(card.options.map((o) => o.id)).toEqual(["just_this_run", "save"]);
    expect(isApiError(await errorOf(api.chooseOption({ messageId: msg.id, key: "criteria-save:AAAAAAAAAAAAAAAA", optionId: "save" })))).toBe(true);
    await api.chooseOption({ messageId: msg.id, key: card.key, optionId: "save" });
    await api.idle();
    const lead = await leadMessages();
    expect(lead.at(-1)!.text).toBe("Saved to your search criteria (now v4).");
    expect(lead.at(-2)).toMatchObject({ author: { type: "ba" }, text: "Save to my criteria" });
    expect(api.state.profiles.find((p) => p.active)?.locations).toContain("Đà Nẵng");
    expect(isApiError(await errorOf(api.chooseOption({ messageId: msg.id, key: card.key, optionId: "save" })))).toBe(true);
  });

  it("UC-21b a: Just this run starts a scan with the per-run override and saves nothing", async () => {
    await api.sendMessage({ roomId: LEAD_ROOM_ID, text: "Also include Đà Nẵng" });
    await api.idle();
    const msg = (await leadMessages()).at(-1)!;
    const card = msg.cards[0] as Extract<MessageCard, { type: "choice" }>;
    await api.chooseOption({ messageId: msg.id, key: card.key, optionId: "just_this_run" });
    await api.idle();
    expect((await leadMessages()).some((m) => m.text.startsWith("OK — Đà Nẵng only for this run."))).toBe(true);
    expect(api.state.profiles.find((p) => p.active)?.version).toBe(3);
  });

  it("UC-21 (PM3 S1): 'scan every weekday at 9' proposes a schedule; Create schedule adds it", async () => {
    const before = api.state.schedules.length;
    await api.sendMessage({ roomId: LEAD_ROOM_ID, text: "Scan every weekday at 9" });
    await api.idle();
    const msg = (await leadMessages()).at(-1)!;
    expect(msg.text).toMatch(/^Create the schedule “Weekday morning scan”\? Runs: Weekdays 09:00 · next run .+ · job scan with your active search criteria\.$/);
    const card = msg.cards[0] as Extract<MessageCard, { type: "choice" }>;
    expect(card.key).toMatch(/^schedule-create:/);
    await api.chooseOption({ messageId: msg.id, key: card.key, optionId: "create" });
    const schedules = api.state.schedules;
    expect(schedules).toHaveLength(before + 1);
    expect(schedules.at(-1)).toMatchObject({ name: "Weekday morning scan", cron: "0 9 * * 1-5", enabled: true });
    expect((await leadMessages()).at(-1)!.text).toMatch(/^Created the schedule “Weekday morning scan” \(Weekdays 09:00\)\./);
  });

  it("UC-24: uploads are checked like checkUploadFile; a JD file starts apply-to-file with no apply link", async () => {
    const good = new File(["%PDF-1.4"], "JD_Acme.pdf", { type: "application/pdf" });
    const bad = new File(["MZ"], "setup.exe", { type: "application/x-msdownload" });
    const res = await api.uploadFiles([good, bad]);
    expect(UploadsResponseSchema.safeParse(res).success).toBe(true);
    expect(res.uploads.map((u) => u.filename)).toEqual(["JD_Acme.pdf"]);
    expect(res.rejected[0]!.filename).toBe("setup.exe");
    await api.sendMessage({ roomId: LEAD_ROOM_ID, text: "", uploadIds: [res.uploads[0]!.id] });
    await api.idle();
    const card = (await api.getReviewQueue()).at(-1)!;
    expect(card.job.company).toBe("Acme");
    expect(card.flags.noApplyLink).toBe(true);
    const approved = await api.approve(card.job.id, { cvVersionId: card.cvOptions[0]!.cvVersion.id, introText: null });
    expect(approved).toEqual({ applicationId: null, taskId: null, approval: null, reapproval: false });
  });

  it("an empty message is refused like ChatSendRequestSchema", async () => {
    const err = await errorOf(api.sendMessage({ roomId: LEAD_ROOM_ID, text: "  " }));
    expect(isApiError(err) && err.code).toBe("validation_failed");
  });
});

describe("mock backend: review (UC-07..12)", () => {
  it("UC-08: approve creates the application and Apply submits; the card leaves the queue", async () => {
    const res = await api.approve("101", { cvVersionId: "2102", introText: null });
    expect(ApproveResponseSchema.safeParse(res).success).toBe(true);
    expect(res.approval?.allowedDomains).toEqual(["itviec.com"]);
    expect((await api.getReviewQueue()).map((c) => c.job.id)).toEqual(["102", "103"]);
    await api.idle();
    const statuses = events.filter((e) => e.type === "application.updated").map((e) => (e as Extract<AppEvent, { type: "application.updated" }>).status);
    expect(statuses).toEqual(["approved", "submitted"]);
    const detail = await api.getRun("12");
    expect(detail.steps.find((s) => s.stepKey === "apply" && s.branchKey === "101")!.status).toBe("done");
    expect((await leadMessages()).at(-1)!.text).toBe("✅ **NovaPay** submitted. Confirmation captured and saved to Applications.");
  });

  it("UC-12: Apply asks one question at a time; skip only for optional, Negotiable only for salary", async () => {
    const res = await api.approve("102", { cvVersionId: "2202", introText: "Xin chào" });
    await api.idle();
    let questions = cardsOf(await leadMessages(), "question");
    expect(questions.map((q) => [q.question.field, q.question.required])).toEqual([["salary", false]]);
    const taskId = res.taskId!;

    const first = await api.answerQuestion(taskId, { field: "salary", mode: "negotiable", value: null, remember: true });
    expect(AnswerQuestionResponseSchema.safeParse(first).success).toBe(true);
    expect(first).toMatchObject({ resumed: false, next: { field: "start_date" } });
    await api.idle();
    questions = cardsOf(await leadMessages(), "question");
    expect(questions.map((q) => [q.question.field, q.answered])).toEqual([
      ["salary", true],
      ["start_date", false],
    ]);
    expect(api.state.savedAnswers.find((a) => a.label === "Mức lương mong muốn (VND)")!.answer).toBe("Thỏa thuận");

    const skip = await errorOf(api.answerQuestion(taskId, { field: "start_date", mode: "skip", value: null, remember: false }));
    expect(isApiError(skip) && skip.message).toMatch(/required/);
    const neg = await errorOf(api.answerQuestion(taskId, { field: "start_date", mode: "negotiable", value: null, remember: false }));
    expect(isApiError(neg) && neg.message).toMatch(/not a salary question/);
    const empty = await errorOf(api.answerQuestion(taskId, { field: "start_date", mode: "answer", value: " ", remember: false }));
    expect(isApiError(empty) && empty.code).toBe("validation_failed");

    await expect(api.answerQuestion(taskId, { field: "start_date", mode: "answer", value: "2 weeks after offer", remember: false })).resolves.toEqual({
      resumed: true,
      next: null,
    });
    await api.idle();
    expect(events.filter((e) => e.type === "task.resumed").length).toBe(1);
    expect((await leadMessages()).at(-1)!.text).toMatch(/Sao Việt Tech\*\* submitted/);
    const late = await errorOf(api.answerQuestion(taskId, { field: "start_date", mode: "answer", value: "x", remember: false }));
    expect(isApiError(late) && late.code).toBe("conflict");
  });

  it("UC-12: an optional question can be skipped (left blank)", async () => {
    const res = await api.approve("102", { cvVersionId: "2203", introText: null });
    await api.idle();
    await api.answerQuestion(res.taskId!, { field: "salary", mode: "skip", value: null, remember: false });
    await api.idle();
    expect(cardsOf(await leadMessages(), "question").map((q) => q.question.field)).toEqual(["salary", "start_date"]);
  });

  it("UC-07 b: a flagged job cannot be approved until Ba confirms it", async () => {
    const err = await errorOf(api.approve("103", { cvVersionId: "2303", introText: null }));
    expect(isApiError(err) && [err.code, err.reason]).toEqual(["forbidden", "injection_flagged"]);
    await api.confirmInjection("103");
    const card = (await api.getReviewQueue()).find((c) => c.job.id === "103")!;
    expect(card.flags.injectionFlagged).toBe(false);
    expect(card.job.injectionClearedAt).not.toBeNull();
    await expect(api.approve("103", { cvVersionId: "2303", introText: null })).resolves.toMatchObject({ taskId: expect.any(String) });
    await api.idle();
  });

  it("UC-09: request changes runs a new CV ⇄ QA round and the card comes back", async () => {
    await api.requestChanges("101", { comment: "Lead with Next.js; drop the education portal project" });
    expect((await api.getReviewQueue()).map((c) => c.job.id)).toEqual(["102", "103"]);
    await api.idle();
    const card = (await api.getReviewQueue()).find((c) => c.job.id === "101")!;
    expect(card.cvOptions[0]!.qaRounds.map((q) => q.total)).toEqual([72, 88, 92]);
    expect(card.cvOptions[0]!.cvVersion.round).toBe(3);
    const tailor = (await api.getRun("12")).steps.find((s) => s.stepKey === "tailor" && s.branchKey === "101:en")!;
    expect((tailor.output as { pass: number; comment: string }).pass).toBe(2);
    expect((tailor.output as { comment: string }).comment).toMatch(/Next\.js/);
    const err = await errorOf(api.requestChanges("102", { comment: " " }));
    expect(isApiError(err) && err.code).toBe("validation_failed");
  });

  it("UC-10: skip needs a reason (and a note for other); the run finishes when every card is decided", async () => {
    const err = await errorOf(api.skip("101", { reason: "other", note: null }));
    expect(isApiError(err) && err.code).toBe("validation_failed");
    await api.skip("101", { reason: "salary_low", note: null });
    await api.skip("102", { reason: "location", note: null });
    await api.skip("103", { reason: "other", note: "Python-heavy" });
    expect(await api.getReviewQueue()).toEqual([]);
    expect((await api.getRun("12")).run.status).toBe("done");
    expect(events.at(-1)).toMatchObject({ type: "run.finished", runId: "12", status: "done" });
  });

  it("unknown jobs and CV versions are refused", async () => {
    expect(isApiError(await errorOf(api.approve("999", { cvVersionId: "1", introText: null })))).toBe(true);
    const err = await errorOf(api.approve("101", { cvVersionId: "2201", introText: null }));
    expect(isApiError(err) && err.code).toBe("validation_failed");
  });
});

describe("mock backend: pauses and run control (UC-16, UC-17, UC-11 e, UC-23)", () => {
  it("UC-17: a login pause resumes when Ba clicks Done", async () => {
    api.simulate("login-expired");
    await api.idle();
    const pause = cardsOf(await leadMessages(), "pause").at(-1)!;
    expect(pause.reason).toBe("needs_login(linkedin.com)");
    await api.resumeTask(pause.taskId);
    await api.idle();
    expect(events.filter((e) => e.type === "task.resumed").map((e) => (e as { taskId: string }).taskId)).toEqual([pause.taskId]);
    expect(isApiError(await errorOf(api.resumeTask(pause.taskId)))).toBe(true);
  });

  it("UC-11 e: a domain confirm resumes only with the exact host", async () => {
    api.simulate("domain-confirm");
    await api.idle();
    const pause = cardsOf(await leadMessages(), "pause").at(-1)!;
    expect(pause.reason).toBe("domain_confirm(acme.wd3.myworkdayjobs.com)");
    const wrong = await errorOf(api.resumeTask(pause.taskId, { confirmDomain: "evil.com" }));
    expect(isApiError(wrong) && wrong.code).toBe("validation_failed");
    await api.resumeTask(pause.taskId, { confirmDomain: "ACME.wd3.myworkdayjobs.com" });
    await api.idle();
  });

  it("needs_figma resumes by itself, not by Done", async () => {
    api.simulate("figma");
    await api.idle();
    const pause = cardsOf(await leadMessages(), "pause").at(-1)!;
    const err = await errorOf(api.resumeTask(pause.taskId));
    expect(isApiError(err) && err.message).toMatch(/resumes by itself/);
  });

  it("UC-16: a usage limit pauses the engine until a reset time; the reset resumes it", async () => {
    api.simulate("claude-limit");
    await api.idle();
    const paused = events.find((e) => e.type === "engine.paused") as Extract<AppEvent, { type: "engine.paused" }>;
    expect(paused.engine).toBe("claude");
    expect(Date.parse(paused.until!)).toBeGreaterThan(Date.now() + 2 * 3600_000);
    expect((await api.getShellData()).usage.find((u) => u.engine === "claude")!.pausedUntil).toBe(paused.until);
    api.simulate("limits-reset");
    await api.idle();
    expect(events.some((e) => e.type === "engine.resumed" && e.engine === "claude")).toBe(true);
  });

  it("UC-23: pause, resume and cancel a run; a submitted Apply step is never re-run", async () => {
    const paused = await api.controlRun("12", "pause");
    expect(RunControlResponseSchema.safeParse(paused).success).toBe(true);
    expect(paused).toMatchObject({ run: { id: "12", status: "paused" }, abortedTaskIds: [] });
    expect((await api.getRun("12")).run.status).toBe("paused");
    await api.controlRun("12", "resume");
    expect((await api.getRun("12")).run.status).toBe("waiting");

    const apply = (await api.getRun("11")).steps.find((s) => s.stepKey === "apply")!;
    const err = await errorOf(api.rerunStep(apply.id));
    expect(isApiError(err) && [err.code, err.message]).toEqual(["forbidden", "A submitted apply step can never be re-run"]);

    await api.controlRun("12", "cancel");
    expect((await api.getRun("12")).run.status).toBe("cancelled");
    expect(await api.getReviewQueue()).toEqual([]);
    expect((await api.getRun("12")).steps.filter((s) => s.stepKey === "review").every((s) => s.status === "cancelled")).toBe(true);
    expect(isApiError(await errorOf(api.controlRun("12", "pause")))).toBe(true);
  });

  it("re-running a lane's tailor step brings its card back after a new round", async () => {
    const tailor = (await api.getRun("12")).steps.find((s) => s.stepKey === "tailor" && s.branchKey === "101:en")!;
    await api.rerunStep(tailor.id);
    await api.idle();
    const card = (await api.getReviewQueue()).find((c) => c.job.id === "101")!;
    expect(card.cvOptions[0]!.qaRounds.length).toBe(3);
    const review = (await api.getRun("12")).steps.find((s) => s.stepKey === "review" && s.branchKey === "101")!;
    expect(review.status).toBe("waiting");
  });
});
