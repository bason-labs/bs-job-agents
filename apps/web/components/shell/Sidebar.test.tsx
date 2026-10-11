import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MOCK_SHELL_DATA } from "@/lib/mock/shell";
import { Sidebar } from "./Sidebar";

vi.mock("next/navigation", () => ({ usePathname: () => "/chat/research" }));

describe("Sidebar", () => {
  it("renders the prototype nav with the Review badge", () => {
    render(<Sidebar data={MOCK_SHELL_DATA} />);
    const nav = screen.getByRole("navigation", { name: "Main" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/chat", "/flows", "/review", "/applications", "/criteria", "/schedules"]);
    expect(within(nav).getByRole("link", { name: /Review/ })).toHaveTextContent("3");
    expect(within(nav).getByRole("link", { name: /^Chat/ })).toHaveAttribute("aria-current", "page");
  });

  it("lists the team with status dots, trust badges, direct chat and settings links", () => {
    render(<Sidebar data={MOCK_SHELL_DATA} />);
    const team = screen.getByRole("list", { name: "Team" });
    const rows = within(team).getAllByRole("listitem");
    expect(rows).toHaveLength(5);
    const research = rows[1]!;
    expect(within(research).getByRole("link", { name: /Chat with Research/ })).toHaveAttribute("href", "/chat/research");
    expect(within(research).getByRole("link", { name: /Chat with Research/ })).toHaveAttribute("aria-current", "page");
    expect(within(research).getByRole("link", { name: "Research settings" })).toHaveAttribute("href", "/bots/research");
    expect(within(research).getByRole("img", { name: "Working" })).toBeInTheDocument();
    expect(within(research).getByText("working")).toBeInTheDocument();
    // PM S9: only Apply carries the trust badge (as in the prototype).
    expect(within(rows[4]!).getByLabelText("Trust level L1")).toBeInTheDocument();
    expect(within(team).getAllByLabelText(/Trust level/)).toHaveLength(1);
    // Lead's chat is the main chat; /chat/lead only redirects there.
    expect(within(rows[0]!).getByRole("link", { name: /Chat with Lead/ })).toHaveAttribute("href", "/chat");
  });

  it("never links to the dev component gallery", () => {
    const { container } = render(<Sidebar data={MOCK_SHELL_DATA} />);
    expect(container.querySelectorAll('a[href^="/dev"]')).toHaveLength(0);
  });

  it("shows rooms, Master CV and subscription usage", () => {
    render(<Sidebar data={MOCK_SHELL_DATA} />);
    expect(screen.getByRole("link", { name: "# cv-brainstorm" })).toHaveAttribute("href", "/rooms/cv-brainstorm");
    expect(screen.getByRole("link", { name: "Master CV" })).toHaveAttribute("href", "/cv");
    expect(screen.getByTestId("usage-claude")).toHaveTextContent("42%");
    expect(screen.getByTestId("usage-chatgpt")).toHaveTextContent("18%");
    expect(screen.getByText("connected")).toBeInTheDocument();
  });
});
