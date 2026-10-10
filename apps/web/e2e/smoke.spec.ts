import { expect, test } from "@playwright/test";

test("home page loads and shows the app title", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/bs-job-agents/);
  await expect(page.getByRole("heading", { level: 1, name: "bs-job-agents" })).toBeVisible();
});
