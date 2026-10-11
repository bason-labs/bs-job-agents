// Sidebar navigation and top-bar titles (prototype copy).
import type { BotSummary, RoomSummary } from "@/lib/api/types";

export interface NavItem {
  href: string;
  label: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/chat", label: "Chat" },
  { href: "/flows", label: "Flows" },
  { href: "/review", label: "Review" },
  { href: "/applications", label: "Applications" },
  { href: "/criteria", label: "Search criteria" },
  { href: "/schedules", label: "Schedules" },
];

/** Lead's chat is the main chat (/chat/lead redirects there); other bots open a direct chat. */
export const botChatHref = (name: string) => (name === "lead" ? "/chat" : `/chat/${name}`);
export const botSettingsHref = (name: string) => `/bots/${name}`;
export const roomHref = (id: string) => `/rooms/${id}`;

export function isNavActive(href: string, pathname: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function isTeamActive(botName: string, pathname: string): boolean {
  return pathname === botChatHref(botName) || pathname === `/chat/${botName}`;
}

const STATIC_TITLES: Record<string, string> = {
  "/chat": "Chat with Lead",
  "/flows": "Flows",
  "/review": "Review queue",
  "/applications": "Applications",
  "/criteria": "Search criteria",
  "/schedules": "Schedules",
  "/bots": "Bots",
  "/cv": "Master CV",
  "/rooms": "Rooms",
};

export function titleForPath(pathname: string, bots: readonly BotSummary[], rooms: readonly RoomSummary[]): string {
  if (STATIC_TITLES[pathname]) return STATIC_TITLES[pathname];
  const [, section, id] = pathname.split("/");
  const botName = (name?: string) => bots.find((b) => b.name === name)?.displayName ?? name ?? "";
  switch (section) {
    case "chat":
      return `Chat with ${botName(id)}`;
    case "flows":
      return `Flow · Job scan #${id}`;
    case "bots":
      return `Bots · ${botName(id)}`;
    case "rooms":
      return `# ${rooms.find((r) => r.id === id)?.name ?? id}`;
    default:
      return "Job Agents";
  }
}
