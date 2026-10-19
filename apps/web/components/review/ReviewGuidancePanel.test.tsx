import { GUIDANCE_SEED, completeGuidanceReview, resolveGuidance, type GuidanceItem, type ReviewGuidance as ReviewGuidanceData, type ReviewerItem } from "@bs-job-agents/shared";
import { reviewCardFixture } from "@bs-job-agents/shared/fixtures";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { GuidancePanel, ReviewGuidance } from "./ReviewGuidancePanel";

const resolved = resolveGuidance(GUIDANCE_SEED, { masterContact: { links: [] }, jobMarket: "global", turnedOff: [] });
const met = (ruleId: string): ReviewerItem => ({ ruleId, status: "met", reason: "Met.", fixable: false, fix: null, needsFact: null });
const judged = resolved.rules.filter((r) => r.check === "judgement").map((r) => r.ruleId);
const checks: GuidanceItem[] = ["dates-month-year", "contact-complete", "skills-practical-experience", "length-pages"].map((ruleId) => ({ ruleId, status: "met", reason: "Met.", fixable: false, fix: null, factRequests: [] }));

function guidance(reviewer: ReviewerItem[], over: Partial<ReviewGuidanceData> = {}): ReviewGuidanceData {
  const items = judged.map((id) => reviewer.find((r) => r.ruleId === id) ?? met(id));
  return { result: completeGuidanceReview(resolved, checks, items, ["f-5"]), rounds: 3, revisions: 2, lastRound: true, ...over };
}

const attention = guidance([
  { ruleId: "order-most-relevant-first", status: "not_met", reason: "The Java role comes after the React work.", fixable: false, fix: null, needsFact: null },
  { ruleId: "bullet-what-tech-result", status: "needs_fact", reason: "The order service bullet has no result.", fixable: false, fix: null, needsFact: { factId: "f-5", question: "What result did optimising the order service have?" } },
]);

describe("the review step's CV guidance panel (REQ-40)", () => {
  it("REQ-40.AC-1: not met and needs fact, in that order, each with its source names; the fact request with Answer", () => {
    render(<GuidancePanel guidance={attention} />);
    expect(screen.getByTestId("guidance-summary")).toHaveTextContent("2 rules need your attention. Checked in 3 rounds; the CV was revised twice.");
    const items = screen.getAllByTestId("guidance-item");
    expect(items.map((i) => i.dataset.rule)).toEqual(["order-most-relevant-first", "bullet-what-tech-result"]);
    expect(within(items[0]!).getByTestId("guidance-item-status")).toHaveTextContent("Not met");
    expect(items[0]).toHaveTextContent("Still not met after round 3");
    expect(within(items[0]!).getByTestId("guidance-item-sources")).toHaveTextContent("Sources: Gửi CV mãi nhưng chưa được phản hồi? (CV tips for IT candidates)");
    const request = within(items[1]!).getByTestId("guidance-fact-request");
    expect(request).toHaveTextContent("What result did optimising the order service have?");
    expect(within(request).getByRole("link", { name: "Answer" })).toHaveAttribute("href", "/cv");
  });

  it("the disclosure lists every rule of this review with its status", async () => {
    const user = userEvent.setup();
    render(<GuidancePanel guidance={attention} />);
    const button = screen.getByRole("button", { name: /All 12 rules in this review/ });
    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("guidance-all-rules")).toHaveTextContent("Overridden");
    expect(screen.getByTestId("guidance-all-rules")).toHaveTextContent("Not applicable");
  });

  it("REQ-40.AC-2: every rule met, not applicable or overridden: one line and no list", () => {
    render(<GuidancePanel guidance={guidance([])} />);
    expect(screen.getByTestId("guidance-all-met")).toHaveTextContent("All CV guidance rules met");
    expect(screen.queryByTestId("guidance-item")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("REQ-37.AC-5: language tabs (ARIA tabs) switch between each language's own result", async () => {
    const user = userEvent.setup();
    const en = reviewCardFixture.cvOptions[0]!;
    const card = {
      cvOptions: [
        { ...en, guidance: attention },
        { ...en, cvVersion: { ...en.cvVersion, id: "cvv_vi", language: "vi" as const }, guidance: guidance([]) },
      ],
    };
    function Harness() {
      const [lang, setLang] = useState<"en" | "vi">("en");
      return <ReviewGuidance card={card} lang={lang} onSelect={setLang} />;
    }
    render(<Harness />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["English CV", "Vietnamese CV"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("2 rules need your attention");
    tabs[0]!.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getAllByRole("tab")[1]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("All CV guidance rules met");
  });

  it("shows nothing when no CV of the card has a guidance result", () => {
    const { container } = render(<ReviewGuidance card={{ cvOptions: reviewCardFixture.cvOptions }} lang="en" onSelect={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
