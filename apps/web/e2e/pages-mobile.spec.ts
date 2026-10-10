import { expect, test } from "@playwright/test";
import { open } from "./helpers";

// Phone width: no horizontal page scroll on the W3c screens (wide tables scroll inside their card).

test.use({ viewport: { width: 390, height: 844 } });

for (const route of ["/applications", "/criteria", "/schedules", "/bots", "/bots/apply", "/cv", "/rooms/cv-brainstorm"]) {
  test(`${route} fits a phone screen`, async ({ page }) => {
    await open(page, route);
    await expect(page.getByTestId("page")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const main = page.locator("main");
    expect(await main.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  });
}

test("the record panel fills a phone screen and still closes", async ({ page }) => {
  await open(page, "/applications");
  await page.getByRole("button", { name: "Open NovaPay's submission record" }).click();
  const panel = page.getByTestId("record-panel");
  const box = (await panel.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(390);
  await panel.getByRole("button", { name: "Close" }).click();
  await expect(panel).toBeHidden();
});
