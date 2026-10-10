import { expect, test } from "@playwright/test";

test("home redirects to chat inside the app shell", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/bs-job-agents/);
  await expect(page.getByTestId("page-title")).toHaveText("Chat with Lead");
  await expect(page.getByText("Job Agents").first()).toBeVisible();
});
