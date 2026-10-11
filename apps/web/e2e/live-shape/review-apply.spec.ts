import { expect, test, type Page } from "@playwright/test";
import { open } from "../helpers";
import { resetOrchestrator, reviewBadge, reviewCard, runnerCalls, scanToReview } from "./live";

// UC-08 … UC-13 on the real orchestrator: Ba's decisions on review cards go through the real API
// (approval tokens, the Apply gate, the record transaction, file serving), and the fake Apply
// leaves real screenshots in the runner's capture folder.

const viewer = (page: Page) => page.getByTestId("file-viewer");
const panel = (page: Page) => page.getByTestId("record-panel");
const appRow = (page: Page, company: string) =>
  page.getByTestId("application-row").filter({ has: page.getByRole("button", { name: `Open ${company}'s submission record` }) });

test.beforeEach(async () => {
  await resetOrchestrator();
});

test("dry run → Apply fills and screenshots but never submits → Approve live → the record with screenshots in Applications", async ({ page }) => {
  await scanToReview(page);
  await open(page, "/review");
  const nova = reviewCard(page, "NovaPay");
  await nova.getByRole("button", { name: "Approve & submit" }).click();
  const dialog = page.getByTestId("approve-dialog");
  await expect(dialog).toContainText("on itviec.com only");
  await dialog.getByRole("checkbox", { name: /Dry run/ }).click();
  await dialog.getByRole("button", { name: "Approve dry run" }).click();
  await expect(dialog).toBeHidden();
  await expect(nova.getByTestId("acted")).toContainText("Dry run: Apply fills the form and stops before submit");

  // The settled dry run brings the card back, with the same CV, for a live approval (PM2 S15).
  await expect(nova.getByRole("button", { name: "Approve live & submit" })).toBeVisible({ timeout: 30_000 });
  const dry = await runnerCalls("apply.submit");
  expect(dry).toHaveLength(1);
  expect(dry[0]!.input.dryRun).toBe(true);
  expect(dry[0]!.input.allowedDomains).toEqual(["itviec.com"]);

  await page.screenshot({ path: "test-results/live-review-dry.png" });
  await nova.getByRole("button", { name: "Approve live & submit" }).click();
  await expect(dialog.getByRole("heading", { name: "Approve live & submit to NovaPay?" })).toBeVisible();
  await dialog.getByRole("button", { name: "Approve live & submit" }).click();
  await expect(page.getByTestId("toast").filter({ hasText: "NovaPay submitted" })).toBeVisible({ timeout: 30_000 });
  await expect(nova).toHaveCount(0);
  const live = await runnerCalls("apply.submit");
  expect(live).toHaveLength(2);
  expect(live[1]!.input.dryRun).toBe(false);
  expect(live[1]!.input.cvVersionId).toBe(dry[0]!.input.cvVersionId);

  // Applications: the submitted record, its screenshots and CV open in the viewer first.
  await open(page, "/applications");
  await page.screenshot({ path: "test-results/live-applications.png" });
  await appRow(page, "NovaPay").getByRole("button", { name: "Open NovaPay's submission record" }).click();
  await expect(panel(page).getByRole("heading", { name: "NovaPay" })).toBeVisible();
  await expect(panel(page).getByTestId("record-sha")).toHaveText(/SHA-256: [0-9a-f]{64}/);
  await expect(panel(page).getByTestId("record-approval")).toContainText("itviec.com");
  await page.screenshot({ path: "test-results/live-record.png" });
  await panel(page).getByRole("button", { name: /Before submit/ }).click();
  await expect(viewer(page).getByRole("img")).toBeVisible();
  await expect(viewer(page).getByRole("img")).toHaveJSProperty("complete", true);
  expect(await viewer(page).getByRole("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(640);
  await page.screenshot({ path: "test-results/live-viewer.png" });
  await viewer(page).getByRole("button", { name: "Close" }).click();
  await panel(page).getByRole("button", { name: /Confirmation/ }).click();
  expect(await viewer(page).getByRole("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(640);
  await viewer(page).getByRole("button", { name: "Close" }).click();
  await panel(page).getByRole("button", { name: /\.pdf$/ }).first().click();
  await expect(viewer(page).getByTestId("pdf-page").first()).toHaveAttribute("data-rendered", "true");
  await expect(viewer(page).getByRole("link", { name: "Download" })).toHaveAttribute("download", /\.pdf$/);
});

test("the Apply node unlocks on the canvas when Ba approves (SSE, no reload)", async ({ page, context }) => {
  const runId = await scanToReview(page);
  const flow = await context.newPage();
  await open(flow, `/flows/${runId}`);
  await flow.screenshot({ path: "test-results/live-flow.png" });
  const applyNodes = flow.locator("[data-testid^=node-apply-]");
  await expect(applyNodes).toHaveCount(3);
  await expect(applyNodes.first()).toContainText("locked");
  await open(page, "/review");
  await reviewCard(page, "Kite Labs").getByRole("button", { name: "Approve & submit" }).click();
  await page.getByTestId("approve-dialog").getByRole("button", { name: "Approve & submit" }).click();
  await expect(flow.locator("[data-testid^=node-apply-][data-status=done], [data-testid^=node-apply-][data-status=running], [data-testid^=node-apply-][data-status=waiting]")).not.toHaveCount(0);
  await flow.screenshot({ path: "test-results/live-flow-after.png" });
  await expect(reviewBadge(page)).toContainText("2");
});
