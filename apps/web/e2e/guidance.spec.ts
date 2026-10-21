import { expect, test, type Page } from "@playwright/test";
import { open } from "./helpers";

// CV guidance (sub-project 3, design screens/guidance.md, review.md, activity.md) on the mock
// orchestrator: the rule set with its sources, Turn off / Turn on, the activity log, and the
// review step's guidance panel per language.

const rule = (page: Page, id: string) => page.locator(`[data-testid="guidance-rule"][data-rule="${id}"]`);
const card = (page: Page, company: string) => page.getByRole("article", { name: new RegExp(`— ${company}$`) });

test("the CV guidance screen lists every rule with its sources; the length rule is disputed and overridden by QA's limit", async ({ page }) => {
  await open(page, "/guidance");
  await expect(page.getByTestId("guidance-summary")).toContainText("12 rules from 4 sources.");
  await expect(page.getByTestId("guidance-rule")).toHaveCount(12);
  const length = rule(page, "length-pages");
  await expect(length.getByTestId("rule-status")).toHaveText("QA limit over_one_page applies");
  await expect(length.getByTestId("guidance-position")).toHaveCount(2);
  const dates = rule(page, "dates-month-year");
  await dates.getByRole("button", { name: "Sources (2)" }).click();
  await expect(dates.getByTestId("guidance-source").first()).toContainText("docs/cv-guidance/vnpt-cv-tips-2026-10.png");
  await expect(dates.getByRole("link", { name: /itviec\.com/ })).toHaveAttribute("rel", "noopener noreferrer");
});

test("§5.9: Ba turns a rule off for his CVs and back on", async ({ page }) => {
  await open(page, "/guidance");
  const order = rule(page, "order-most-relevant-first");
  await order.getByRole("button", { name: "Turn off for my CVs" }).click();
  await expect(order.getByTestId("rule-status")).toHaveText("Turned off by you");
  await order.getByRole("button", { name: "Turn on" }).click();
  await expect(order.getByTestId("rule-status")).toHaveText("Sources agree");
});

test("the sidebar has CV guidance after Master CV, and Activity after Schedules", async ({ page }) => {
  await open(page, "/chat");
  const sidebar = page.getByTestId("sidebar");
  await sidebar.getByRole("link", { name: "CV guidance" }).click();
  await expect(page).toHaveURL(/\/guidance$/);
  await sidebar.getByRole("link", { name: "Activity" }).click();
  await expect(page).toHaveURL(/\/activity$/);
});

test("REQ-36: the activity log shows each rule added, with previous and new text and sources", async ({ page }) => {
  await open(page, "/activity");
  // The rule entries only: the log also lists skill repairs and API health (skill self-repair).
  const entries = page.locator('[data-testid="activity-entry"][data-kind^="rule_"]');
  await expect(entries).toHaveCount(12);
  await entries.first().getByRole("button").click();
  await expect(entries.first().getByTestId("activity-previous")).toHaveText("(empty: this rule is new)");
  await expect(entries.first().getByTestId("activity-source").first()).toBeVisible();
});

test("REQ-40: the review step shows what needs Ba, per language; or All CV guidance rules met", async ({ page }) => {
  await open(page, "/review");
  const nova = card(page, "NovaPay");
  const panel = nova.getByTestId("guidance-panel");
  await expect(panel.getByTestId("guidance-summary")).toContainText("2 rules need your attention. Checked in 2 rounds; the CV was revised once.");
  await expect(panel.getByTestId("guidance-item")).toHaveCount(2);
  await expect(panel.getByTestId("guidance-fact-request")).toContainText("start and end months");
  const sao = card(page, "Sao Việt Tech");
  await expect(sao.getByRole("tab", { name: "Vietnamese CV" })).toHaveAttribute("aria-selected", "true");
  await expect(sao.getByTestId("guidance-all-met")).toHaveText("All CV guidance rules met");
  await sao.getByRole("tab", { name: "English CV" }).click();
  await expect(sao.getByTestId("guidance-all-met")).toBeVisible();
  // The review actions are never blocked by guidance.
  await expect(nova.getByRole("button", { name: "Approve & submit" })).toBeEnabled();
});
