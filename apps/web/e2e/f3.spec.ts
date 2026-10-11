import { expect, test, type Page } from "@playwright/test";
import { open, simulate, withMock, type MockHandle } from "./helpers";

// F3 (PM2 S8, S11, S15, S16) in the UI, on the mock orchestrator: Approve live after a settled dry
// run, the companyMissing flag, "Don't allow" on a domain confirm, and the figma-change chip.

const card = (page: Page, company: string) => page.getByRole("article", { name: new RegExp(`— ${company}$`) });
const lead = (page: Page) => page.locator("[data-testid=message][data-author=lead]");

async function dryRunNovaPay(page: Page) {
  await open(page, "/review");
  const nova = card(page, "NovaPay");
  await nova.getByRole("button", { name: "Approve & submit" }).click();
  const dialog = page.getByTestId("approve-dialog");
  await dialog.getByRole("checkbox", { name: "Dry run" }).click();
  await dialog.getByRole("button", { name: "Approve dry run" }).click();
  // The dry run settles and the card comes back for a live decision.
  await expect(nova.getByTestId("flag-dryRunSettled")).toBeVisible({ timeout: 30_000 });
  return nova;
}

test("PM2 S15: after a settled dry run the card offers Approve live, with the same CV and no dry run", async ({ page }) => {
  const nova = await dryRunNovaPay(page);
  await nova.getByRole("button", { name: "Approve live & submit" }).click();
  const dialog = page.getByTestId("approve-dialog");
  await expect(dialog.getByRole("heading", { name: "Approve live & submit to NovaPay?" })).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: "Dry run" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Approve live & submit" }).click();
  await expect(page.getByTestId("toast").filter({ hasText: "NovaPay submitted" })).toBeVisible({ timeout: 20_000 });
});

test("PM2 S15: a dry run that reported 'submitted' must be checked first (already_applied)", async ({ page }) => {
  const nova = await dryRunNovaPay(page);
  await withMock(page, (mock: MockHandle) => {
    const dry = Object.values(mock.state.applications).find((a) => a.dryRun && a.status === "needs_check")!;
    dry.statusHistory.push({ status: "needs_check", at: new Date().toISOString(), note: "dry run reported submitted" });
  });
  await nova.getByRole("button", { name: "Approve live & submit" }).click();
  await page.getByTestId("approve-dialog").getByRole("button", { name: "Approve live & submit" }).click();
  await expect(page.getByTestId("toast").filter({ hasText: "Check it on the Applications screen and mark it failed before approving live." })).toBeVisible();
});

test("PM2 S16: a card whose company research failed says so", async ({ page }) => {
  await open(page, "/chat");
  await withMock(page, (mock: MockHandle) => {
    const c = mock.state.queue.find((x) => x.job.id === "102")!;
    c.flags.companyMissing = true;
  });
  await page.getByTestId("sidebar").getByRole("link", { name: /^Review/ }).click();
  await expect(card(page, "Sao Việt Tech").getByTestId("flag-companyMissing")).toHaveText("Company research failed · continuing without it. CV tailored this CV without a company profile.");
});

test("UC-11 e: Don't allow stops Apply instead of using the other site", async ({ page }) => {
  await open(page, "/chat");
  await simulate(page, /Apply leaves the job site/);
  const pause = page.getByTestId("pause-card").last();
  await pause.getByRole("button", { name: "Don't allow" }).click();
  await expect(pause).toHaveAttribute("data-state", "declined");
  await expect(pause).toContainText("Not allowed — Apply stopped and won't continue on acme.wd3.myworkdayjobs.com.");
  await expect(lead(page).filter({ hasText: "Apply stopped and did not continue on acme.wd3.myworkdayjobs.com" })).toBeVisible();
});

test("PM2 S8: a protected Figma change asks Ba with a chip; 'That was me — retry' goes through /chat/choices", async ({ page }) => {
  await open(page, "/chat");
  await withMock(page, (mock: MockHandle) => mock.simulate("figma-change"));
  const choice = page.getByTestId("choice-card").last();
  await choice.getByRole("button", { name: "That was me — retry" }).click();
  await expect(choice).toContainText("You chose “That was me — retry”.");
  await expect(lead(page).filter({ hasText: "CV is tailoring again" })).toBeVisible();
});
