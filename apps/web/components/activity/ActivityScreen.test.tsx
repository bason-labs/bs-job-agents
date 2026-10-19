import type { ActivityEntry } from "@bs-job-agents/shared";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { testMock } from "@/lib/api/mock/testing";
import { createGuidanceData } from "@/components/guidance/data";
import { ActivityEntryItem, ActivityScreen } from "./ActivityScreen";

const AT = "2026-10-18T08:00:00.000Z";
const source = { id: "hr-1", title: "<b>HR</b> guide", publisher: null, url: "javascript:alert(1)", repoPath: null, retrievedAt: AT, kind: "hr_publication", market: "global" as const };

const added: ActivityEntry = { id: "2", at: AT, kind: "rule_added", ruleId: "summary-short", point: "A short summary opens the CV", previousText: "", newText: "Open with a two-line summary.", sources: [source], applied: true, runId: "13" };
const changed: ActivityEntry = { ...added, id: "1", kind: "rule_changed", ruleId: "length-pages", point: "How many pages the CV has", previousText: "Keep the CV to 1–2 pages.", newText: "Keep the CV to 1–2 pages.\nOne page early in a career." };

describe("the activity log (REQ-36)", () => {
  it("REQ-36.AC-1: an added and a changed rule with the same time; each shows the rule, previous and new text and sources", async () => {
    const user = userEvent.setup();
    render(<ActivityScreen entries={[added, changed]} />);
    const entries = screen.getAllByTestId("activity-entry");
    expect(entries.map((e) => e.dataset.kind)).toEqual(["rule_added", "rule_changed"]);
    expect(entries.map((e) => e.querySelector("time")?.getAttribute("datetime"))).toEqual([AT, AT]);
    await user.click(within(entries[0]!).getByRole("button"));
    expect(within(entries[0]!).getByTestId("activity-previous")).toHaveTextContent("(empty: this rule is new)");
    expect(within(entries[0]!).getByTestId("activity-new")).toHaveTextContent("+ Open with a two-line summary.");
    await user.click(within(entries[1]!).getByRole("button"));
    expect(within(entries[1]!).getByTestId("activity-previous")).toHaveTextContent("- Keep the CV to 1–2 pages.");
    expect(within(entries[1]!).getByTestId("activity-source")).toHaveTextContent("<b>HR</b> guide");
  });

  it("SEC-26: source names are text and a non-https URL is no link", async () => {
    const user = userEvent.setup();
    const { container } = render(<ActivityEntryItem entry={added} />);
    await user.click(screen.getByRole("button"));
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
  });

  it("an entry whose commit failed says it was not applied", async () => {
    const user = userEvent.setup();
    render(<ActivityEntryItem entry={{ ...added, applied: false }} />);
    await user.click(screen.getByRole("button"));
    expect(screen.getByTestId("activity-body")).toHaveTextContent("Not applied");
  });

  it("empty: no changes yet", () => {
    render(<ActivityScreen entries={[]} />);
    expect(screen.getByTestId("empty-state")).toHaveTextContent("No changes yet");
  });

  it("the mock backend serves the seed's rules as added entries", async () => {
    const entries = await createGuidanceData(testMock()).activity();
    expect(entries).toHaveLength(12);
    expect(entries.every((e) => e.kind === "rule_added")).toBe(true);
  });
});
