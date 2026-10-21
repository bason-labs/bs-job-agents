import { GUIDANCE_SEED, guidanceRuleViews, type GuidanceRuleView, type GuidanceView } from "@bs-job-agents/shared";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui";
import { testMock } from "@/lib/api/mock/testing";
import { createGuidanceData, type GuidanceData } from "./data";
import { GuidanceRuleCard, SourceLine } from "./GuidanceRule";
import { GuidanceScreen } from "./GuidanceScreen";
import { safeHref, summaryLine } from "./model";

const rules = guidanceRuleViews(GUIDANCE_SEED, []);
const rule = (id: string) => rules.find((r) => r.ruleId === id)!;

function view(over: Partial<GuidanceView> = {}): GuidanceView {
  return {
    snapshot: 2,
    sourceCount: 4,
    lastRefresh: { at: "2026-10-18T08:00:00.000Z", runId: "13", outcome: "updated", pagesChecked: 3, failed: 0, rulesChanged: 2, error: null },
    lastSuccessAt: "2026-10-18T08:00:00.000Z",
    rules,
    ...over,
  };
}

function renderScreen(v: GuidanceView, data: GuidanceData = createGuidanceData(testMock())) {
  return render(
    <ToastProvider>
      <GuidanceScreen initial={v} data={data} />
    </ToastProvider>,
  );
}

describe("CV guidance screen (§7)", () => {
  it("shows the summary line and one card per rule; a disputed rule shows every position with Applied or Not applied and why", () => {
    renderScreen(view());
    expect(screen.getByTestId("guidance-summary")).toHaveTextContent("12 rules from 4 sources. Last checked");
    expect(screen.getByTestId("guidance-summary")).toHaveTextContent("changed 2 rules.");
    expect(screen.getAllByTestId("guidance-rule")).toHaveLength(12);
    const length = screen.getAllByTestId("guidance-rule").find((c) => c.dataset.rule === "length-pages")!;
    expect(within(length).getByTestId("rule-status")).toHaveTextContent("QA limit over_one_page applies");
    expect(within(length).getAllByTestId("guidance-position")).toHaveLength(2);
    expect(within(length).getByTestId("guidance-why")).toHaveTextContent(/over_one_page/);
    const links = screen.getAllByTestId("guidance-rule").find((c) => c.dataset.rule === "links-profile")!;
    expect(links).toHaveTextContent("Applies only when your master CV has a LinkedIn, GitHub or portfolio link.");
  });

  it("opens an agreed rule's sources in place: title, address, retrieval date and quote", async () => {
    const user = userEvent.setup();
    renderScreen(view());
    const card = screen.getAllByTestId("guidance-rule").find((c) => c.dataset.rule === "dates-month-year")!;
    const button = within(card).getByRole("button", { name: /Sources \(2\)/ });
    expect(button).toHaveAttribute("aria-expanded", "false");
    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    const sources = within(card).getAllByTestId("guidance-source");
    expect(sources[0]).toHaveTextContent("docs/cv-guidance/vnpt-cv-tips-2026-10.png");
    expect(within(sources[0]!).queryByRole("link")).toBeNull();
    expect(within(sources[1]!).getByRole("link")).toHaveAttribute("href", "https://itviec.com/blog/huong-dan-viet-mau-cv-an-tuong-cho-it/");
    expect(within(sources[1]!).getByRole("link")).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("SEC-26.AC-1: a title with markup shows as text and a javascript: URL is not a link", () => {
    const { container } = render(
      <ul>
        <SourceLine source={{ id: "x", title: "<img src=x onerror=alert(1)>", publisher: null, url: "javascript:alert(1)", repoPath: null, retrievedAt: "2026-10-19T00:00:00Z", kind: "hr_publication", market: "global", evidence: null }} />
      </ul>,
    );
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("http://hr.example.com")).toBeNull();
    expect(safeHref("https://hr.example.com/x")).toBe("https://hr.example.com/x");
  });

  it("refresh failed: the banner, and the summary names the last successful check", () => {
    renderScreen(view({ lastRefresh: { at: "2026-10-19T08:00:00.000Z", runId: "14", outcome: "failed", pagesChecked: 3, failed: 3, rulesChanged: 0, error: "no guidance page could be read (HTTP 503)" } }));
    expect(screen.getByTestId("guidance-refresh-banner")).toHaveTextContent("CV guidance refresh failed: no guidance page could be read (HTTP 503).");
    expect(screen.getByTestId("guidance-refresh-banner")).toHaveTextContent("The previous rule set stays in force and tailoring goes on with it.");
    expect(screen.getByTestId("guidance-summary")).toHaveTextContent("Last successful check");
  });

  it("partial: some sources could not be read; no banner", () => {
    renderScreen(view({ lastRefresh: { at: "2026-10-19T08:00:00.000Z", runId: "14", outcome: "unchanged", pagesChecked: 5, failed: 3, rulesChanged: 0, error: null } }));
    expect(screen.getByTestId("guidance-partial")).toHaveTextContent("3 of 5 sources could not be read this run; their rules stay as they were.");
    expect(screen.queryByTestId("guidance-refresh-banner")).toBeNull();
  });

  it("empty: no rules yet, with the way to start a scan", () => {
    renderScreen(view({ rules: [], sourceCount: 0, lastRefresh: null }));
    expect(screen.getByTestId("empty-state")).toHaveTextContent("No guidance rules yet");
    expect(screen.getByRole("link", { name: "Open Lead to start a scan" })).toHaveAttribute("href", "/chat");
  });

  it("§5.9: Turn off for my CVs, then Turn on (through the API)", async () => {
    const user = userEvent.setup();
    const data = createGuidanceData(testMock());
    renderScreen(await data.view(), data);
    const card = () => screen.getAllByTestId("guidance-rule").find((c) => c.dataset.rule === "order-most-relevant-first")!;
    await user.click(within(card()).getByRole("button", { name: "Turn off for my CVs" }));
    expect(await within(card()).findByText("Turned off by you")).toBeInTheDocument();
    await user.click(within(card()).getByRole("button", { name: "Turn on" }));
    expect(await within(card()).findByText("Sources agree")).toBeInTheDocument();
  });

  it("the card's toggle calls back with the rule", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<GuidanceRuleCard rule={rule("skills-jd-relevant") as GuidanceRuleView} onToggle={onToggle} />);
    await user.click(screen.getByTestId("rule-toggle"));
    expect(onToggle).toHaveBeenCalledWith(expect.objectContaining({ ruleId: "skills-jd-relevant" }));
  });

  it("summaryLine says when nothing was checked yet", () => {
    expect(summaryLine(view({ lastRefresh: null }))).toBe("12 rules from 4 sources. Not checked by a scan yet.");
  });
});
