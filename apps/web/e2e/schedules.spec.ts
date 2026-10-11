import { expect, test, type Page } from "@playwright/test";
import { open } from "./helpers";

// UC-21: manage schedules in the modal editor; delete with a confirmation and an Undo toast.

const rows = (page: Page) => page.getByTestId("schedule-row");
const editor = (page: Page) => page.getByTestId("schedule-editor");

test.beforeEach(async ({ page }) => {
  await open(page, "/schedules");
});

test("creates a weekly schedule with the TimePicker (UC-21)", async ({ page }) => {
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first().getByTestId("schedule-summary")).toHaveText(
    "Weekdays 09:00 · criteria Default (v3) · next: Mon 12 Oct, 09:00 · last: Fri 9 Oct · 3 to review",
  );

  await page.getByRole("button", { name: "+ New schedule" }).click();
  const dialog = editor(page);
  await expect(dialog.getByRole("heading", { name: "New schedule" })).toBeVisible();
  await expect(dialog.getByTestId("schedule-runs")).toHaveText("Runs: Weekdays 09:00");

  await dialog.getByLabel("Name").fill("Friday evening scan");
  await dialog.getByRole("radio", { name: "Weekly" }).click();
  await dialog.getByTestId("schedule-day").click();
  await page.getByRole("option", { name: "Fri" }).click();
  // TimePicker: a Select of 30-minute slots, scrolled to the chosen one.
  await dialog.getByTestId("schedule-time").click();
  await page.getByRole("option", { name: "18:30" }).click();
  await expect(dialog.getByTestId("schedule-runs")).toHaveText("Runs: Every Fri 18:30");
  await dialog.getByRole("button", { name: "Save" }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("toast").filter({ hasText: "Schedule created" })).toBeVisible();
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).nth(1)).toContainText("Friday evening scan");
  await expect(rows(page).nth(1).getByTestId("schedule-summary")).toContainText("Every Fri 18:30 · criteria Default (v3) · next: Fri ");
});

test("validates the name and a custom cron (spec §11)", async ({ page }) => {
  await page.getByRole("button", { name: "+ New schedule" }).click();
  const dialog = editor(page);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Give the schedule a name");
  await expect(dialog.getByLabel("Name")).toBeFocused();

  await dialog.getByLabel("Name").fill("Custom");
  await dialog.getByRole("radio", { name: "Custom" }).click();
  await dialog.getByLabel("Cron expression").fill("0 9 * *");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Cron needs 5 fields, e.g. 0 9 * * 1-5");
  await dialog.getByLabel("Cron expression").fill("15 9 * * 1-5");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByTestId("schedule-runs")).toHaveText("Runs: cron: 15 9 * * 1-5");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(rows(page).nth(1).getByTestId("schedule-summary")).toContainText("cron: 15 9 * * 1-5");
});

test("edits a schedule by clicking its row", async ({ page }) => {
  await rows(page).first().click();
  const dialog = editor(page);
  await expect(dialog.getByRole("heading", { name: "Edit schedule" })).toBeVisible();
  await expect(dialog.getByLabel("Name")).toHaveValue("Weekday morning scan");
  await expect(dialog.getByRole("radio", { name: "Weekdays" })).toHaveAttribute("aria-checked", "true");
  await dialog.getByLabel("Name").fill("Morning scan");
  // Repeat is a radio group: arrow keys move the choice.
  await dialog.getByRole("radio", { name: "Weekdays" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(dialog.getByRole("radio", { name: "Daily" })).toHaveAttribute("aria-checked", "true");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("toast").filter({ hasText: "Schedule updated" })).toBeVisible();
  await expect(rows(page).first()).toContainText("Morning scan");
  await expect(rows(page).first().getByTestId("schedule-summary")).toContainText("Daily 09:00");
});

test("deletes from the row after confirming, and Undo restores it (UC-21)", async ({ page }) => {
  await rows(page).first().getByRole("button", { name: "Delete Weekday morning scan" }).click();
  const confirm = page.getByTestId("confirm-dialog");
  await expect(confirm).toContainText("Delete “Weekday morning scan”?");
  await expect(confirm).toContainText("Future scans from this schedule stop. Past runs, review cards and applications are kept. You can undo for a few seconds.");
  await confirm.getByRole("button", { name: "Delete schedule" }).click();

  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByTestId("schedules-empty")).toContainText("No schedules — scans only run when you ask Lead.");
  const toast = page.getByTestId("toast").filter({ hasText: "Deleted “Weekday morning scan”" });
  await expect(toast).toBeVisible();
  await toast.getByRole("button", { name: "Undo" }).click();

  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByTestId("toast").filter({ hasText: "Restored “Weekday morning scan”" })).toBeVisible();
});

test("deletes from inside the edit modal; the empty state offers to create one", async ({ page }) => {
  await rows(page).first().click();
  await editor(page).getByRole("button", { name: "Delete" }).click();
  await expect(editor(page)).toBeHidden();
  await page.getByTestId("confirm-dialog").getByRole("button", { name: "Delete schedule" }).click();
  await expect(page.getByTestId("schedules-empty")).toBeVisible();
  await page.getByTestId("schedules-empty").getByRole("button", { name: "Create one" }).click();
  await expect(editor(page).getByRole("heading", { name: "New schedule" })).toBeVisible();
});

test("turns a schedule off with its switch", async ({ page }) => {
  const toggle = rows(page).first().getByRole("switch", { name: "Weekday morning scan enabled" });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(rows(page).first().getByTestId("schedule-summary")).toContainText("next: off");
  await expect(editor(page)).toBeHidden();
});

test("Run now opens the new run's flow (UC-21)", async ({ page }) => {
  await rows(page).first().getByRole("button", { name: "Run now" }).click();
  await expect(page).toHaveURL(/\/flows\/\d+$/);
});
