import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ToastProvider } from "@/components/ui";
import { createFixtureRoomsData } from "./data";
import { RoomScreen } from "./RoomScreen";

async function setup() {
  const data = createFixtureRoomsData({ replyDelayMs: 30 });
  const [room, messages, bots] = await Promise.all([data.getRoom("cv-brainstorm"), data.messages("cv-brainstorm"), data.bots()]);
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <RoomScreen room={room!} initialMessages={messages} bots={bots} data={data} />
    </ToastProvider>,
  );
  return { user, data };
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
    const { user } = await setup();
    await user.type(composer(), "@r");
    const list = screen.getByTestId("mention-list");
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual([expect.stringMatching(/Research/)]);
    expect(composer()).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Enter}");
    expect(composer()).toHaveValue("@Research ");
    expect(screen.queryByTestId("mention-list")).toBeNull();

    await user.type(composer(), "which JDs ask for Next.js?{Enter}");
    expect(composer()).toHaveValue("");
    expect(authors()).toEqual(["ba", "cv", "qa", "ba"]);
    expect(screen.getByTestId("room-waiting")).toHaveTextContent("Research is answering…");
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

  it("chooses a suggestion with the mouse", async () => {
    const { user } = await setup();
    await user.type(composer(), "Ask @q");
    await user.click(screen.getByRole("option", { name: /QA/ }));
    expect(composer()).toHaveValue("Ask @QA ");
  });

  it("explains that a message without a mention goes to no bot", async () => {
    const { user } = await setup();
    await user.type(composer(), "just thinking out loud{Enter}");
    expect(await screen.findByRole("status")).toHaveTextContent("No bot mentioned — type @ to ask a specific bot.");
  });
});
