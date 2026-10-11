import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui";
import { gatedSleep, testMock } from "@/lib/api/mock/testing";
import { ApiProvider } from "@/lib/api/react";
import { createRoomsData } from "./data";
import { RoomLive, RoomScreen } from "./RoomScreen";
import { RoomsLive } from "./RoomsScreen";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

/** The room on the mock orchestrator. Its bots wait on `gate` until the test releases them. */
async function setup(limit = 50) {
  const gate = gatedSleep();
  const mock = testMock({ sleep: gate.sleep });
  const data = createRoomsData(mock);
  const [room, page, bots] = await Promise.all([data.getRoom("cv-brainstorm"), data.messages("cv-brainstorm", { limit }), data.bots()]);
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <RoomScreen room={room!} initialMessages={page.messages} initialHasMore={page.hasMore} bots={bots} data={data} />
    </ToastProvider>,
  );
  return { user, data, mock, release: gate.release };
}

const composer = () => screen.getByRole("combobox", { name: "Message #cv-brainstorm" });
const authors = () => screen.getAllByTestId("room-message").map((m) => m.dataset.author);

describe("RoomScreen (UC-15)", () => {
  it("shows the discussion-mode note, the members and the conversation", async () => {
    await setup();
    expect(screen.getByText("Discussion mode — bots answer only when @mentioned and never take actions here.")).toBeInTheDocument();
    expect(screen.getByTestId("room-members")).toHaveTextContent(/Members:.*Lead.*Research.*CV.*QA.*Apply/);
    expect(authors()).toEqual(["ba", "cv", "qa"]);
  });

  it("suggests bots after @, inserts the chosen one, and the mentioned bot answers", async () => {
    const { user, mock, release } = await setup();
    await user.type(composer(), "@r");
    const list = await screen.findByTestId("mention-list");
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual([expect.stringMatching(/Research/)]);
    expect(composer()).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Enter}");
    expect(composer()).toHaveValue("@Research ");
    expect(screen.queryByTestId("mention-list")).toBeNull();

    await user.type(composer(), "which JDs ask for Next.js?{Enter}");
    // Research is held at the gate, so "answering…" can be checked without racing its reply.
    await waitFor(() => expect(composer()).toHaveValue(""));
    await waitFor(() => expect(authors()).toEqual(["ba", "cv", "qa", "ba"]));
    expect(screen.getByTestId("room-waiting")).toHaveTextContent("Research is answering…");
    release();
    await mock.idle();
    await waitFor(() => expect(authors()).toEqual(["ba", "cv", "qa", "ba", "research"]));
    expect(screen.queryByTestId("room-waiting")).toBeNull();
    expect(screen.getAllByTestId("room-message").at(-1)).toHaveTextContent("I can pull 3 example JDs");
  });

  it("navigates suggestions with the arrow keys, chooses with Tab, and closes with Escape", async () => {
    const { user } = await setup();
    await user.type(composer(), "@");
    expect(within(screen.getByTestId("mention-list")).getAllByRole("option")).toHaveLength(5);
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(within(screen.getByTestId("mention-list")).getByRole("option", { selected: true })).toHaveTextContent(/CVTailors/);
    await user.keyboard("{Tab}");
    expect(composer()).toHaveValue("@CV ");
    await user.type(composer(), "@");
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("mention-list")).toBeNull();
  });

  it("loads earlier messages when the history has more (paged API)", async () => {
    const { user } = await setup(1);
    expect(authors()).toEqual(["qa"]);
    await user.click(screen.getByRole("button", { name: "Load earlier messages" }));
    await waitFor(() => expect(authors()).toEqual(["ba", "cv", "qa"]));
    expect(screen.queryByRole("button", { name: "Load earlier messages" })).toBeNull();
  });

  it("chooses a suggestion with the mouse", async () => {
    const { user } = await setup();
    await user.type(composer(), "Ask @q");
    await user.click(screen.getByRole("option", { name: /QA/ }));
    expect(composer()).toHaveValue("Ask @QA ");
  });

  it("explains that a message without a mention goes to no bot", async () => {
    const { user, mock } = await setup();
    await user.type(composer(), "just thinking out loud{Enter}");
    expect(await screen.findByRole("status")).toHaveTextContent("No bot mentioned — type @ to ask a specific bot.");
    // Sent with POST /chat/messages, answered by no one.
    expect(mock.state.messages["cv-brainstorm"]!.at(-1)).toMatchObject({ author: { type: "ba" }, mentions: [] });
  });

  it("stops showing a bot as answering when the server says it won't (system note)", async () => {
    const { user, mock, release } = await setup();
    mock.state.rooms.find((r) => r.id === "cv-brainstorm")!.members = ["cv", "qa"];
    await user.type(composer(), "@Lead make it a task{Enter}");
    await waitFor(() => expect(screen.getByTestId("room-waiting")).toHaveTextContent("Lead is answering…"));
    await mock.post("cv-brainstorm", { type: "system" }, "@Lead will not answer: lead is disabled.");
    await waitFor(() => expect(screen.queryByTestId("room-waiting")).toBeNull());
    release();
    await mock.idle();
  });
});

describe("RoomLive and RoomsLive (the pages)", () => {
  function page(ui: React.ReactNode) {
    const mock = testMock();
    render(
      <ApiProvider mode="mock" api={mock}>
        <ToastProvider>{ui}</ToastProvider>
      </ApiProvider>,
    );
    return { mock, user: userEvent.setup() };
  }

  it("opens a room by id, and says Not found for an unknown one", async () => {
    page(<RoomLive id="cv-brainstorm" />);
    expect(await screen.findByRole("combobox", { name: "Message #cv-brainstorm" })).toBeInTheDocument();
  });

  it("says Not found for an unknown room", async () => {
    page(<RoomLive id="nope" />);
    expect(await screen.findByText("Not found")).toBeInTheDocument();
  });

  it("lists group rooms and each bot's direct thread, and creates a room", async () => {
    const { user, mock } = page(<RoomsLive />);
    const links = await screen.findAllByTestId("room-link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/rooms/cv-brainstorm"]);
    expect(screen.getAllByTestId("direct-room-link").map((l) => l.getAttribute("href"))).toEqual(["/chat/research", "/chat/cv", "/chat/qa", "/chat/apply"]);

    const form = screen.getByTestId("new-room");
    await user.click(within(form).getByRole("button", { name: "Create room" }));
    expect(within(form).getByText("Name the room")).toBeInTheDocument();
    expect(within(form).getByText("Pick at least one bot")).toBeInTheDocument();
    await user.type(within(form).getByLabelText("Name"), "salary-talk");
    await user.click(within(form).getByRole("checkbox", { name: "Research" }));
    await user.click(within(form).getByRole("button", { name: "Create room" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith(expect.stringMatching(/^\/rooms\/\d+$/)));
    expect(mock.state.rooms.at(-1)).toMatchObject({ name: "salary-talk", kind: "group", members: ["research"] });
  });
});
