// Skill self-repair (scan-notices.md): a repair or API notice carries "Open the activity log".
import type { Message } from "@bs-job-agents/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageCards } from "./MessageCards";

const message: Message = {
  id: "m1",
  roomId: "r1",
  mode: "work",
  author: { type: "bot", bot: "lead" },
  text: "Automatic repair failed: the validation scan returned 0 jobs. TopCV keeps its previous skill and later scans still use it.",
  uploadIds: [],
  createdAt: "2026-10-19T09:00:00.000Z",
  mentions: [],
  runIds: [],
  cards: [{ type: "activity_link" }],
};

describe("MessageCards: activity_link", () => {
  it("links to the activity log", () => {
    render(<MessageCards message={message} />);
    const link = screen.getByTestId("activity-link");
    expect(link).toHaveTextContent("Open the activity log");
    expect(link.getAttribute("href")).toBe("/activity");
  });
});
