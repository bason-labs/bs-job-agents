import { expect, test } from "@playwright/test";
import { open } from "../helpers";
import { resetOrchestrator, reviewBadge, reviewCard, runnerCalls, scanToReview } from "./live";

// UC-09, UC-10 and UC-12 on the real orchestrator.

test.beforeEach(async () => {
  await resetOrchestrator();
});

test("UC-09: request changes → CV gets Ba's note → a new QA round → the card comes back", async ({ page }) => {
  await scanToReview(page);
  await open(page, "/review");
  const card = reviewCard(page, "Mây Xanh Software");
  await expect(card.getByTestId("qa-box")).toContainText("round 1 of 3");
  await card.getByRole("button", { name: "Request changes…" }).click();
  const dialog = page.getByTestId("changes-dialog");
  await dialog.getByLabel("What should change?").fill("Lead with the Next.js dashboard work");
  await dialog.getByRole("button", { name: "Send to CV" }).click();
  await expect(card.getByTestId("acted")).toContainText("CV is revising with your note");
  await expect(card.getByTestId("qa-box")).toContainText("round 2 of 3", { timeout: 30_000 });
  await expect(card.getByTestId("qa-rounds")).toContainText("R2");
  await expect(card.getByRole("button", { name: "Approve & submit" })).toBeVisible();
  const tailors = await runnerCalls("cv.tailor");
  const revised = tailors.filter((c) => JSON.stringify(c.input).includes("Lead with the Next.js dashboard work"));
  expect(revised).toHaveLength(1);
});

test("UC-10: skip with a reason → the card leaves the queue and stays out after a reload", async ({ page }) => {
  await scanToReview(page);
  await open(page, "/review");
  await reviewCard(page, "Kite Labs").getByRole("button", { name: "Skip (give reason)" }).click();
  const dialog = page.getByTestId("skip-dialog");
  await dialog.getByRole("radio", { name: "Other" }).click();
  await dialog.getByLabel("Note").fill("Remote only, not for me");
  await dialog.getByRole("button", { name: "Skip job" }).click();
  await expect(reviewCard(page, "Kite Labs")).toHaveCount(0);
  await expect(page.getByTestId("skipped")).toHaveText("Skipped: Kite Labs (other)");
  await expect(reviewBadge(page)).toContainText("2");
  await page.reload();
  await expect(reviewCard(page, "NovaPay")).toBeVisible();
  await expect(reviewCard(page, "Kite Labs")).toHaveCount(0);
  expect(await runnerCalls("apply.submit")).toHaveLength(0);
});

test("UC-12: Apply pauses on a question → Ba answers in chat → Apply resumes with the answer and submits", async ({ page }) => {
  await scanToReview(page);
  await open(page, "/review");
  await reviewCard(page, "Kite Labs").getByRole("button", { name: "Approve & submit" }).click();
  await page.getByTestId("approve-dialog").getByRole("button", { name: "Approve & submit" }).click();
  await expect(page.getByTestId("approve-dialog")).toBeHidden();

  await open(page, "/chat");
  const question = page.locator("[data-testid=question-card][data-field=notice_period]");
  await expect(question).toBeVisible({ timeout: 30_000 });
  await expect(question).toContainText("Notice period (weeks)");
  await question.getByRole("textbox").fill("4");
  await question.getByRole("button", { name: "Send" }).click();
  await expect(question).not.toHaveAttribute("data-state", "live");

  await expect.poll(async () => (await runnerCalls("apply.submit")).length, { timeout: 30_000 }).toBe(2);
  const [first, second] = await runnerCalls("apply.submit");
  expect(first!.input.answers).toEqual([]);
  expect(JSON.stringify(second!.input.answers)).toContain('"4"');
  await open(page, "/applications");
  await expect(page.getByTestId("application-row").filter({ hasText: "Kite Labs" }).getByRole("combobox")).toContainText("Submitted", { timeout: 30_000 });
});
