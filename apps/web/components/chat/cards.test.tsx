import type { Message, MessageCard, PendingQuestion, Room } from "@bs-job-agents/shared";
import { messageFixture } from "@bs-job-agents/shared/fixtures";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { WebApi } from "@/lib/api/contract";
import { ApiRequestError } from "@/lib/api/errors";
import { ApiProvider } from "@/lib/api/react";
import { MOCK_BOTS } from "@/lib/mock/shell";
import { ChatContext, type ChatContextValue } from "./ChatContext";
import type { TaskPhase } from "./model";
import { PauseCard } from "./PauseCard";
import { QuestionCard } from "./QuestionCard";

const LEAD_ROOM: Room = { id: "lead", name: "Lead", kind: "lead", botName: "lead", members: ["lead"], createdAt: "2026-10-10T08:00:00Z" };

function setup(ui: ReactNode, o: { api?: Partial<WebApi>; messages?: Message[]; phase?: TaskPhase; bot?: string } = {}) {
  const api = {
    mode: "mock",
    events: { subscribe: () => () => {}, getStatus: () => "open", onStatus: () => () => {} },
    answerQuestion: vi.fn(async () => {}),
    resumeTask: vi.fn(async () => {}),
    ...o.api,
  } as unknown as WebApi;
  const ctx: ChatContextValue = {
    room: LEAD_ROOM,
    bots: MOCK_BOTS,
    messages: o.messages ?? [],
    taskPhase: () => o.phase,
    taskBot: () => o.bot,
    uploads: {},
  };
  render(
    <ApiProvider mode="mock" api={api}>
      <ChatContext.Provider value={ctx}>{ui}</ChatContext.Provider>
    </ApiProvider>,
  );
  return api as WebApi & { answerQuestion: ReturnType<typeof vi.fn>; resumeTask: ReturnType<typeof vi.fn> };
}

const question = (q: Partial<PendingQuestion> = {}, answered = false): Extract<MessageCard, { type: "question" }> => ({
  type: "question",
  applicationId: "a1",
  taskId: "t1",
  question: { field: "salary", label: "Expected salary (VND)", required: false, kind: "salary", options: null, ...q },
  answered,
});
const holding = (card: MessageCard): Message[] => [{ ...messageFixture, id: "m1", cards: [card] }];

describe("QuestionCard (UC-12)", () => {
  it("optional salary: Negotiable and Skip; remember is on by default; Negotiable answers", async () => {
    const card = question();
    const api = setup(<QuestionCard card={card} />, { messages: holding(card) });
    expect(screen.getByText("Optional field — you can skip it")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Remember this answer for future forms" })).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Negotiable / Thỏa thuận" }));
    expect(api.answerQuestion).toHaveBeenCalledWith("t1", { field: "salary", mode: "negotiable", value: null, remember: true });
    expect(screen.getByTestId("question-card")).toHaveAttribute("data-state", "answered");
    expect(screen.getByText("Saved as a remembered answer for future forms.")).toBeInTheDocument();
  });

  it("a typed salary is sent as digits, formatted with thousands separators", async () => {
    const card = question();
    const api = setup(<QuestionCard card={card} />, { messages: holding(card) });
    await userEvent.click(screen.getByRole("checkbox", { name: "Remember this answer for future forms" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Expected salary (VND)" }), "32000000");
    expect(screen.getByRole("textbox", { name: "Expected salary (VND)" })).toHaveValue("32,000,000");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(api.answerQuestion).toHaveBeenCalledWith("t1", { field: "salary", mode: "answer", value: "32000000", remember: false });
    expect(screen.getByText("32,000,000")).toBeInTheDocument();
    expect(screen.getByText("Used for this form only.")).toBeInTheDocument();
  });

  it("a required text field has no Skip or Negotiable, and Send waits for an answer", async () => {
    const card = question({ field: "start", label: "Earliest start date", required: true, kind: "date" });
    setup(<QuestionCard card={card} />, { messages: holding(card) });
    expect(screen.getByText("Required field")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Skip/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Negotiable/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Earliest start date" })).toHaveAttribute("placeholder", "e.g. 2 weeks after offer");
  });

  it("choice fields answer with one click on an option", async () => {
    const card = question({ field: "permit", label: "Work permit?", required: true, kind: "choice", options: ["Yes", "No"] });
    const api = setup(<QuestionCard card={card} />, { messages: holding(card) });
    await userEvent.click(screen.getByRole("button", { name: "Yes" }));
    expect(api.answerQuestion).toHaveBeenCalledWith("t1", expect.objectContaining({ field: "permit", mode: "answer", value: "Yes" }));
  });

  it("shows the server's refusal and stays live", async () => {
    const card = question();
    setup(<QuestionCard card={card} />, {
      messages: holding(card),
      api: { answerQuestion: vi.fn(async () => Promise.reject(new ApiRequestError({ status: 409, code: "conflict", message: "task t1 is not waiting for an answer" }))) },
    });
    await userEvent.click(screen.getByRole("button", { name: "Skip — leave blank" }));
    expect(screen.getByRole("alert")).toHaveTextContent("task t1 is not waiting for an answer");
    expect(screen.getByTestId("question-card")).toHaveAttribute("data-state", "live");
  });

  it("turns inert when its task ended, a newer question replaced it, or it was answered (PM S24)", () => {
    const card = question();
    setup(<QuestionCard card={card} />, { messages: holding(card), phase: "ended" });
    expect(screen.getByTestId("question-card")).toHaveAttribute("data-state", "closed");
  });

  it("is answered when the server says so (after a reload)", () => {
    const card = question({}, true);
    setup(<QuestionCard card={card} />, { messages: holding(card) });
    expect(screen.getByTestId("question-card")).toHaveAttribute("data-state", "answered");
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });
});

describe("PauseCard (UC-17, UC-11 e)", () => {
  it("domain confirm shows the host and sends it to resume", async () => {
    const api = setup(<PauseCard card={{ type: "pause", taskId: "t9", reason: "domain_confirm(acme.wd3.myworkdayjobs.com)" }} />);
    expect(screen.getByTestId("pause-host")).toHaveTextContent("acme.wd3.myworkdayjobs.com");
    await userEvent.click(screen.getByRole("button", { name: "Allow acme.wd3.myworkdayjobs.com" }));
    expect(api.resumeTask).toHaveBeenCalledWith("t9", { confirmDomain: "acme.wd3.myworkdayjobs.com" });
    expect(screen.getByTestId("pause-card")).toHaveAttribute("data-state", "resumed");
  });

  it("login: Done resumes with no domain; the bot from the task event is named", async () => {
    const api = setup(<PauseCard card={{ type: "pause", taskId: "t9", reason: "needs_login(topcv.vn)" }} />, { bot: "research" });
    expect(screen.getByText(/Research paused because topcv.vn needs you to log in/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Done — I'm logged in" }));
    expect(api.resumeTask).toHaveBeenCalledWith("t9", { confirmDomain: null });
  });

  it("Figma waits by itself (no Done); an ended task is inert", () => {
    setup(<PauseCard card={{ type: "pause", taskId: "t9", reason: "needs_figma" }} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/Figma Desktop Bridge/)).toBeInTheDocument();
  });

  it("an ended task shows that it ended", () => {
    setup(<PauseCard card={{ type: "pause", taskId: "t9", reason: "captcha(topcv.vn)" }} />, { phase: "ended" });
    expect(screen.getByText("This task has ended.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
