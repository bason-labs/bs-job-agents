import { describe, expect, it } from "vitest";
import { MOCK_SHELL_DATA } from "@/lib/mock/shell";
import { NAV_ITEMS, botChatHref, isNavActive, isTeamActive, titleForPath } from "./routes";

describe("NAV_ITEMS", () => {
  it("matches the prototype sidebar order and copy", () => {
    expect(NAV_ITEMS.map((n) => n.label)).toEqual(["Chat", "Flows", "Review", "Applications", "Search criteria", "Schedules"]);
    expect(NAV_ITEMS.map((n) => n.href)).toEqual(["/chat", "/flows", "/review", "/applications", "/criteria", "/schedules"]);
  });
});

describe("titleForPath", () => {
  const bots = MOCK_SHELL_DATA.bots;
  const rooms = MOCK_SHELL_DATA.rooms;
  it.each([
    ["/chat", "Chat with Lead"],
    ["/chat/research", "Chat with Research"],
    ["/flows", "Flows"],
    ["/flows/12", "Flow · Job scan #12"],
    ["/review", "Review queue"],
    ["/applications", "Applications"],
    ["/criteria", "Search criteria"],
    ["/schedules", "Schedules"],
    ["/bots", "Bots"],
    ["/bots/apply", "Bots · Apply"],
    ["/cv", "Master CV"],
    ["/rooms/cv-brainstorm", "# cv-brainstorm"],
  ])("%s → %s", (path, title) => {
    expect(titleForPath(path, bots, rooms)).toBe(title);
  });
});

describe("botChatHref", () => {
  it("sends Lead to the main chat (/chat/lead only redirects there) and other bots to their direct chat", () => {
    expect(botChatHref("lead")).toBe("/chat");
    expect(botChatHref("research")).toBe("/chat/research");
  });
});

describe("active state", () => {
  it("marks Chat active for any chat route", () => {
    expect(isNavActive("/chat", "/chat")).toBe(true);
    expect(isNavActive("/chat", "/chat/cv")).toBe(true);
    expect(isNavActive("/flows", "/flows/12")).toBe(true);
    expect(isNavActive("/flows", "/chat")).toBe(false);
  });

  it("marks Lead active on /chat and each bot on its direct chat", () => {
    expect(isTeamActive("lead", "/chat")).toBe(true);
    expect(isTeamActive("lead", "/chat/lead")).toBe(true);
    expect(isTeamActive("cv", "/chat/cv")).toBe(true);
    expect(isTeamActive("cv", "/chat")).toBe(false);
  });
});
