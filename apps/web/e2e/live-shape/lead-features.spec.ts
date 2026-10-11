import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { open } from "../helpers";
import { leadMessages, resetOrchestrator, reviewCard, runnerCalls, sayToLead, scanToReview, unzip } from "./live";

// UC-16, UC-21b a, UC-21 and UC-13b on the real orchestrator.

test.beforeEach(async () => {
  await resetOrchestrator();
});

test("UC-16: a usage limit pauses Claude with a banner; at the reset the queue resumes by itself and Lead answers", async ({ page }) => {
  await sayToLead(page, "[usage-limit] what's new?");
  const banner = page.getByTestId("paused-banner");
  await expect(banner).toBeVisible({ timeout: 20_000 });
  await expect(banner).toContainText("Claude");
  await expect(page.getByTestId("usage-claude")).toContainText("paused");
  // The launcher's reset is a few seconds away: no click, no reload.
  await expect(banner).toBeHidden({ timeout: 30_000 });
  await expect(leadMessages(page).filter({ hasText: "Back after the usage pause." })).toBeVisible({ timeout: 20_000 });
  const chats = await runnerCalls("lead.chat");
  expect(chats.map((c) => c.taskId)).toEqual([chats[0]!.taskId, chats[0]!.taskId]);
});

test("UC-21b a: Lead proposes a criteria change; Ba's click saves a new version (server-side, never from Lead's words)", async ({ page }) => {
  await sayToLead(page, "Also look in Đà Nẵng");
  const proposal = leadMessages(page).filter({ hasText: "Save to your search criteria (now v1)? Add Đà Nẵng to locations." });
  await expect(proposal).toBeVisible({ timeout: 20_000 });
  await expect(proposal).toContainText("Đà Nẵng");
  await proposal.getByRole("button", { name: "Save to my criteria" }).click();
  await expect(page.locator("[data-testid=message]").filter({ hasText: "Saved to your search criteria (now v2)." })).toBeVisible();
  // Single use: the chips are settled.
  await expect(proposal).toContainText("You chose “Save to my criteria”.");
  await expect(proposal.getByRole("button")).toHaveCount(0);
  await open(page, "/criteria");
  await expect(page.getByTestId("page")).toContainText("Đà Nẵng");
  await expect(page.getByTestId("page")).toContainText("v2");
  // Saving never started a run.
  expect((await runnerCalls()).filter((c) => c.key !== "lead.chat")).toHaveLength(0);
});

test("UC-21: a schedule proposed in chat is created by Ba's click; Run now on Schedules starts a scan", async ({ page }) => {
  await sayToLead(page, "Scan every weekday at 9");
  const proposal = leadMessages(page).filter({ hasText: "Create the schedule “Weekday morning scan”?" });
  await expect(proposal).toBeVisible({ timeout: 20_000 });
  await expect(proposal).toContainText("Runs: Weekdays 09:00");
  await proposal.getByRole("button", { name: "Create schedule" }).click();
  await open(page, "/schedules");
  const row = page.getByTestId("schedule-row").filter({ hasText: "Weekday morning scan" });
  await expect(row).toBeVisible();
  await expect(row.getByTestId("schedule-summary")).toContainText("Weekdays 09:00");

  // A schedule made on the screen itself.
  await page.getByRole("button", { name: "+ New schedule" }).click();
  const dialog = page.getByTestId("schedule-editor");
  await dialog.getByLabel("Name").fill("Friday evening scan");
  await dialog.getByRole("radio", { name: "Weekly" }).click();
  await dialog.getByTestId("schedule-day").click();
  await page.getByRole("option", { name: "Fri" }).click();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("toast").filter({ hasText: "Schedule created" })).toBeVisible();
  await expect(page.getByTestId("schedule-row")).toHaveCount(2);
  await page.reload();
  await expect(page.getByTestId("schedule-row")).toHaveCount(2);

  await row.getByRole("button", { name: "Run now" }).click();
  await expect(page).toHaveURL(/\/flows\/\d+$/);
  await expect(page.getByTestId("node-scan")).toHaveAttribute("data-status", "done", { timeout: 30_000 });
  expect((await runnerCalls("research.scan")).length).toBe(2);
});

test("UC-13b: Export all (ZIP) downloads the CSV and each submitted application's folder; dry runs are left out", async ({ page }) => {
  await scanToReview(page);
  await open(page, "/review");
  // One live submission and one dry run.
  await reviewCard(page, "NovaPay").getByRole("button", { name: "Approve & submit" }).click();
  await page.getByTestId("approve-dialog").getByRole("button", { name: "Approve & submit" }).click();
  await reviewCard(page, "Mây Xanh Software").getByRole("button", { name: "Approve & submit" }).click();
  await page.getByTestId("approve-dialog").getByRole("checkbox", { name: /Dry run/ }).click();
  await page.getByTestId("approve-dialog").getByRole("button", { name: "Approve dry run" }).click();
  await expect.poll(async () => (await runnerCalls("apply.submit")).length, { timeout: 30_000 }).toBe(2);

  await open(page, "/applications");
  await expect(page.getByTestId("application-row")).toHaveCount(2);
  await expect(page.getByTestId("application-row").filter({ hasText: "NovaPay" }).getByRole("combobox")).toContainText("Submitted");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export all (ZIP)" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^applications-.*\.zip$/);
  await expect(page.getByTestId("toast").filter({ hasText: /Exported 1 applications/ })).toBeVisible();
  const entries = unzip(readFileSync((await download.path())!));
  const names = [...entries.keys()];
  const csv = entries.get("applications.csv")!.toString("utf8");
  expect(csv).toContain("NovaPay");
  expect(csv).not.toContain("Mây Xanh");
  expect(names.some((n) => /NovaPay.*\/submission\.json$/i.test(n))).toBe(true);
  expect(names.some((n) => /\.pdf$/.test(n))).toBe(true);
  expect(names.some((n) => /pre-submit\.png$/.test(n))).toBe(true);
  expect(names.some((n) => /May.?Xanh/i.test(n))).toBe(false);
  const record = entries.get(names.find((n) => n.endsWith("submission.json"))!)!.toString("utf8");
  expect(record).toMatch(/"approvalToken": null/);
  expect(record).not.toMatch(/"approvalToken": "/);
  await expect(page.getByTestId("applications-header")).toContainText("last export");
});
