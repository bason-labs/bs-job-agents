import type { ActivityEntry, GuidanceActivityEntry, SkillRepairActivityEntry, SourceApiActivityEntry } from "@bs-job-agents/shared";
import { render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { ToastProvider } from "@/components/ui";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { testMock } from "@/lib/api/mock/testing";
import { createGuidanceData } from "@/components/guidance/data";
import { ActivityEntryItem, ActivityScreen } from "./ActivityScreen";

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: ToastProvider });

const AT = "2026-10-18T08:00:00.000Z";
const source = { id: "hr-1", title: "<b>HR</b> guide", publisher: null, url: "javascript:alert(1)", repoPath: null, retrievedAt: AT, kind: "hr_publication", market: "global" as const };

const added: GuidanceActivityEntry = { id: "2", at: AT, kind: "rule_added", ruleId: "summary-short", point: "A short summary opens the CV", previousText: "", newText: "Open with a two-line summary.", sources: [source], applied: true, runId: "13" };
const changed: GuidanceActivityEntry = { ...added, id: "1", kind: "rule_changed", ruleId: "length-pages", point: "How many pages the CV has", previousText: "Keep the CV to 1–2 pages.", newText: "Keep the CV to 1–2 pages.\nOne page early in a career." };

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

  it("the mock backend serves the seed's rules as added entries, after the illustrative skill repairs", async () => {
    const entries = await createGuidanceData(testMock()).activity();
    expect(entries.filter((e) => e.kind === "rule_added")).toHaveLength(12);
    expect(entries.slice(0, 3).map((e) => e.kind)).toEqual(["skill_adopted", "skill_repair_paused", "skill_not_adopted"]);
  });
});

const BASE: SkillRepairActivityEntry = {
  id: "50",
  at: "2026-10-17T09:00:00.000Z",
  kind: "skill_adopted",
  repairId: "3",
  source: "topcv",
  sourceLabel: "TopCV",
  trigger: "adapter broken: no job cards on the results page (layout changed?)",
  status: null,
  reason: null,
  path: "bots/research/skills/source-topcv/SKILL.md",
  previousText: "- Cards: `.job-item-search-result`",
  newText: "- Cards: `article.job-card`",
  notApplied: [{ file: "bots/research/bot.json", change: "new allowed site topcv.com.vn" }],
  canRestore: true,
  canRetry: false,
};

describe("skill repairs in the activity log (REQ-11, sub-project 4 §7)", () => {
  it("REQ-11.AC-1, REQ-13.AC-2: an adopted repair shows the source, time, reason, the diff with - and +, what was not applied and that only the skill file changed", async () => {
    const user = userEvent.setup();
    render(<ActivityScreen entries={[BASE]} />);
    const entry = screen.getByTestId("activity-entry");
    expect(entry.dataset.kind).toBe("skill_adopted");
    expect(entry).toHaveTextContent("Adopted");
    expect(entry).toHaveTextContent("TopCV");
    expect(entry).toHaveTextContent("adapter broken: no job cards");
    expect(entry.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-17T09:00:00.000Z");
    expect(screen.getByTestId("activity-degraded-note")).toHaveTextContent("Adopted changes do not put the research bot in the degraded start state.");
    await user.click(within(entry).getByRole("button", { expanded: false }));
    expect(screen.getByTestId("activity-previous")).toHaveTextContent("- - Cards: `.job-item-search-result`");
    expect(screen.getByTestId("activity-new")).toHaveTextContent("+ - Cards: `article.job-card`");
    expect(screen.getByTestId("activity-not-applied")).toHaveTextContent("bots/research/bot.json: new allowed site topcv.com.vn");
    expect(screen.getByTestId("activity-scope")).toHaveTextContent("Only bots/research/skills/source-topcv/SKILL.md changed. This change is not committed to git yet.");
    // Read-only without data: no restore button.
    expect(screen.queryByRole("button", { name: "Restore previous skill" })).toBeNull();
  });

  it("'Restore previous skill' calls the API and shows the restored entry; it is offered only when allowed", async () => {
    const user = userEvent.setup();
    const restored: SkillRepairActivityEntry = { ...BASE, id: "51", kind: "skill_restored", previousText: BASE.newText, newText: BASE.previousText, canRestore: false };
    const data = { restoreSkill: vi.fn(async () => [restored, { ...BASE, canRestore: false }]), retrySkillRepair: vi.fn() };
    render(<ActivityScreen entries={[BASE]} data={data} />);
    await user.click(screen.getByRole("button", { expanded: false }));
    await user.click(screen.getByRole("button", { name: "Restore previous skill" }));
    expect(data.restoreSkill).toHaveBeenCalledWith("3");
    await waitFor(() => expect(screen.getAllByTestId("activity-entry").map((e) => e.dataset.kind)).toEqual(["skill_restored", "skill_adopted"]));
    expect(screen.getAllByTestId("activity-entry")[0]).toHaveTextContent("Restored the previous skill");

    const { container } = render(<ActivityEntryItem entry={{ ...BASE, id: "60", canRestore: false }} actions={{ restore: vi.fn(), retry: vi.fn() }} />);
    await user.click(within(container).getByRole("button", { expanded: false }));
    expect(within(container).queryByRole("button", { name: "Restore previous skill" })).toBeNull();
  });

  it("REQ-11.AC-2: a repair not adopted says so, gives the reason and shows the draft that was tried", async () => {
    const user = userEvent.setup();
    render(<ActivityEntryItem entry={{ ...BASE, kind: "skill_not_adopted", reason: "the validation scan returned 0 jobs", path: null, previousText: null, newText: "- tried", canRestore: false }} />);
    await user.click(screen.getByRole("button"));
    expect(screen.getByTestId("activity-not-adopted")).toHaveTextContent("Not adopted. The skill text is unchanged.");
    expect(screen.getByTestId("activity-body")).toHaveTextContent("Why: the validation scan returned 0 jobs");
    expect(screen.getByTestId("activity-new")).toHaveTextContent("+ - tried");
  });

  it("repairing: the reason and what runs now, no diff (one entry per attempt)", () => {
    render(<ActivityEntryItem entry={{ ...BASE, kind: "skill_repairing", status: "validating", previousText: null, newText: null, path: null, canRestore: false }} />);
    expect(screen.getByTestId("activity-entry")).toHaveTextContent("Repairing");
    expect(screen.getByTestId("repair-status")).toHaveTextContent("Validation scan running");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("paused: 'Try repair again' calls the API with the source", async () => {
    const user = userEvent.setup();
    const paused: SkillRepairActivityEntry = { ...BASE, kind: "skill_repair_paused", repairId: null, trigger: null, reason: "3 attempts in a row were not adopted", path: null, previousText: null, newText: null, canRestore: false, canRetry: true };
    const data = { restoreSkill: vi.fn(), retrySkillRepair: vi.fn(async () => [{ ...paused, canRetry: false }]) };
    render(<ActivityScreen entries={[paused]} data={data} />);
    expect(screen.getByTestId("activity-entry")).toHaveTextContent("Automatic repair paused after 3 failed attempts");
    await user.click(screen.getByRole("button", { name: "Try repair again" }));
    expect(data.retrySkillRepair).toHaveBeenCalledWith("topcv");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Try repair again" })).toBeNull());
  });

  it("API changed and recovered: the source, method, host and path, the reason; no diff", () => {
    const api: SourceApiActivityEntry = { id: "70", at: "2026-10-19T10:00:00.000Z", kind: "api_changed", source: "itviec", sourceLabel: "ITviec", method: "GET", host: "itviec.com", path: "/it-jobs/react", reason: "itviec.com/it-jobs/react answered HTTP 404" };
    render(<ActivityScreen entries={[api, { ...api, id: "71", kind: "api_recovered", reason: null }] as ActivityEntry[]} />);
    const [changed, recovered] = screen.getAllByTestId("activity-entry");
    expect(changed).toHaveTextContent("API changed");
    expect(changed).toHaveTextContent("GET itviec.com/it-jobs/react");
    expect(changed).toHaveTextContent("Scans use the browser until the API works again.");
    expect(recovered).toHaveTextContent("API recovered");
    expect(screen.queryByTestId("skill-diff")).toBeNull();
  });

  it("the mock backend restores once and retries a source", async () => {
    const data = createGuidanceData(testMock());
    const after = await data.restoreSkill("3");
    expect(after[0]).toMatchObject({ kind: "skill_restored", source: "topcv" });
    await expect(data.restoreSkill("3")).rejects.toThrow(/latest adopted repair/);
    const retried = await data.retrySkillRepair("itviec");
    expect(retried[0]).toMatchObject({ kind: "skill_repairing", source: "itviec", status: "drafting" });
    // QA L2: only a paused source, once.
    await expect(data.retrySkillRepair("itviec")).rejects.toThrow(/not paused/);
    await expect(data.retrySkillRepair("topcv")).rejects.toThrow(/not paused/);
  });
});
