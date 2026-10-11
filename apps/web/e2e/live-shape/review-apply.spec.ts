import { expect, test, type Page } from "@playwright/test";
import { open } from "../helpers";
import { resetOrchestrator, reviewBadge, reviewCard, runnerCalls, scanToReview } from "./live";

// UC-08 … UC-13 on the real orchestrator: Ba's decisions on review cards go through the real API
// (approval tokens, the Apply gate, the record transaction, file serving), and the fake Apply
// leaves real screenshots in the runner's capture folder.

const viewer = (page: Page) => page.getByTestId("file-viewer");
const panel = (page: Page) => page.getByTestId("record-panel");
const appRow = (page: Page, company: string, dryRun = false) =>
  page
    .getByTestId("application-row")
    .filter({ has: page.getByRole("button", { name: `Open ${company}'s submission record` }) })
    .filter(dryRun ? { hasText: "dry run" } : { hasNotText: "dry run" });

/** The viewer shows a real image (the fake Apply's 640×400 PNG, served by the orchestrator). */
async function expectScreenshotShown(page: Page) {
  const img = viewer(page).getByRole("img");
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => (i.complete ? i.naturalWidth : -1))).toBe(640);
}

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
  await expect(page.getByTestId("application-row")).toHaveCount(2);
  // The dry run is labelled; its record holds the filled form's screenshot, and nothing was sent.
  await expect(appRow(page, "NovaPay", true).getByRole("combobox")).toContainText("Needs check");
  await appRow(page, "NovaPay", true).getByRole("button", { name: "Open NovaPay's submission record" }).click();
  await panel(page).getByRole("button", { name: /Before submit/ }).click();
  await expectScreenshotShown(page);
  await viewer(page).getByRole("button", { name: "Close" }).click();
  await expect(panel(page).getByRole("button", { name: /Confirmation/ })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();
  await appRow(page, "NovaPay").getByRole("button", { name: "Open NovaPay's submission record" }).click();
  await expect(panel(page).getByRole("heading", { name: "NovaPay" })).toBeVisible();
  await expect(panel(page).getByTestId("record-sha")).toHaveText(/SHA-256: [0-9a-f]{64}/);
  await expect(panel(page).getByTestId("record-approval")).toContainText("itviec.com");
  await panel(page).getByRole("button", { name: /Before submit/ }).click();
  await expect(viewer(page).getByRole("img")).toBeVisible();
  await expectScreenshotShown(page);
  await viewer(page).getByRole("button", { name: "Close" }).click();
  await panel(page).getByRole("button", { name: /Confirmation/ }).click();
  await expectScreenshotShown(page);
  await viewer(page).getByRole("button", { name: "Close" }).click();
  await panel(page).getByRole("button", { name: /\.pdf$/ }).first().click();
  await expect(viewer(page).getByTestId("pdf-page").first()).toHaveAttribute("data-rendered", "true");
  await expect(viewer(page).getByRole("link", { name: "Download" })).toHaveAttribute("download", /\.pdf$/);
});

test("the canvas follows the run over SSE: the Apply node unlocks when Ba approves, then the record is saved (no reload)", async ({ page, context }) => {
  const runId = await scanToReview(page);
  const queue = (await (await page.request.get("/api/review")).json()) as { cards: { job: { id: string; company: string } }[] };
  const novaId = queue.cards.find((c) => c.job.company === "NovaPay")!.job.id;
  const flow = await context.newPage();
  await open(flow, `/flows/${runId}`);
  await expect(flow.getByTestId("node-scan")).toHaveAttribute("data-status", "done");
  await expect(flow.locator("[data-testid^=node-apply-]")).toHaveCount(3);
  const apply = flow.getByTestId(`node-apply-${novaId}`);
  await expect(apply).toHaveAttribute("data-status", "locked");
  await expect(apply).toContainText("locked");
  await expect(flow.getByTestId(`node-review-${novaId}`)).toHaveAttribute("data-status", "waiting");

  await open(page, "/review");
  await reviewCard(page, "NovaPay").getByRole("button", { name: "Approve & submit" }).click();
  await page.getByTestId("approve-dialog").getByRole("button", { name: "Approve & submit" }).click();
  // The other tab never reloads: every change below arrives over SSE.
  await expect(flow.getByTestId(`node-review-${novaId}`)).toHaveAttribute("data-status", "done");
  await expect(apply).toHaveAttribute("data-status", /^(running|done)$/);
  await expect(apply).toHaveAttribute("data-status", "done");
  await expect(flow.getByTestId(`node-record-${novaId}`)).toHaveAttribute("data-status", "done");
  await expect(flow.getByTestId(`node-record-${novaId}`)).toContainText("record saved");
  await expect(reviewBadge(page)).toContainText("2");
});
