import { expect, test } from "@playwright/test";
import { cursorOffenders, nativeControls, open, simulate, withMock } from "./helpers";

// Spec §11 rules on the chat, flows and review screens: cursor: pointer on everything clickable
// (not-allowed when disabled), and no browser-default controls.

const SCREENS = ["/chat", "/chat/research", "/review", "/flows", "/flows/12"];

for (const path of SCREENS) {
  test(`${path}: cursor rule and own components`, async ({ page }) => {
    await open(page, path);
    await page.locator("[data-testid=message], [data-testid=review-card], [data-testid=run-row], [data-testid=node-scan], [data-testid=greeting]").first().waitFor();
    expect(await cursorOffenders(page)).toEqual([]);
    expect(await nativeControls(page)).toEqual([]);
  });
}

test("cards, dialogs, drawer and menus follow the rules too", async ({ page }) => {
  await open(page, "/chat");
  await withMock(page, (m) => m.approve("102", { cvVersionId: "2202", introText: null }));
  await page.getByTestId("question-card").first().waitFor();
  await simulate(page, /Apply leaves the job site/);
  await page.getByTestId("pause-card").first().waitFor();
  expect(await cursorOffenders(page)).toEqual([]);
  expect(await nativeControls(page)).toEqual([]);

  await open(page, "/review");
  await page.getByRole("article", { name: /NovaPay$/ }).getByRole("button", { name: "Skip (give reason)" }).click();
  await page.getByTestId("skip-dialog").waitFor();
  expect(await cursorOffenders(page)).toEqual([]);
  await page.keyboard.press("Escape");

  await open(page, "/flows/12");
  await page.getByTestId("node-scan").click();
  await page.getByTestId("step-drawer").waitFor();
  expect(await cursorOffenders(page)).toEqual([]);
});
