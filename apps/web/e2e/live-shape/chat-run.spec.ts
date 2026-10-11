import { expect, test } from "@playwright/test";
import { open } from "../helpers";
import { leadMessages, resetOrchestrator, reviewBadge, runnerCalls, sayToLead } from "./live";

// UC-01 on the real orchestrator: Ba's message → a lead.chat task → the fake Lead calls
// start_workflow over its MCP capability → the run card (from the capability log) → the scan runs
// step by step over SSE → three review cards.

test.beforeEach(async () => {
  await resetOrchestrator();
});

test("UC-01: chat → Lead starts job-scan through MCP → run card → the canvas fills live → review queue", async ({ page }) => {
  await open(page, "/chat");
  await expect(page.getByText("Sample data")).toHaveCount(0);
  await sayToLead(page, "Please scan for frontend jobs in HCM");
  await expect(page.getByTestId("typing")).toContainText("Lead is working");
  await expect(leadMessages(page).filter({ hasText: "Starting a job scan on TopCV and ITviec…" })).toBeVisible();
  const card = page.getByTestId("run-card").first();
  await expect(card).toBeVisible();
  await expect(card).toContainText(/Job scan #\d+/);
  await expect(leadMessages(page).last()).toContainText("Research is scanning TopCV and ITviec.");
  await page.screenshot({ path: "test-results/live-chat.png" });
  await expect(reviewBadge(page)).toContainText("3", { timeout: 45_000 });
  await page.screenshot({ path: "test-results/live-chat-done.png" });
  const keys = (await runnerCalls()).map((c) => c.key);
  expect(keys.filter((k) => k === "research.scan")).toHaveLength(2);
  expect(keys.filter((k) => k === "qa.review").length).toBeGreaterThanOrEqual(3);
});
