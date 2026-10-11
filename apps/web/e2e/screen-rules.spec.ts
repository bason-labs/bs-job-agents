import { expect, test } from "@playwright/test";
import { cursorOffenders, directFileLinks, nativeControls, open, simulate, withMock } from "./helpers";

// Spec §11 rules on every screen: cursor: pointer on everything clickable (not-allowed when
// disabled), no browser-default controls, and files open in the viewer before any download.

const SCREENS = ["/chat", "/chat/research", "/review", "/flows", "/flows/12"];

for (const path of SCREENS) {
  test(`${path}: cursor rule, own components, viewer first`, async ({ page }) => {
    await open(page, path);
    await page.locator("[data-testid=message], [data-testid=review-card], [data-testid=run-row], [data-testid=node-scan], [data-testid=greeting]").first().waitFor();
    expect(await cursorOffenders(page)).toEqual([]);
    expect(await nativeControls(page)).toEqual([]);
    expect(await directFileLinks(page)).toEqual([]);
  });
}

// The settings screens (W3c) and the rooms (Phase 3 QA: every route).
const SETTINGS_SCREENS = ["/applications", "/criteria", "/schedules", "/bots", "/bots/apply", "/cv", "/rooms", "/rooms/cv-brainstorm"];

for (const path of SETTINGS_SCREENS) {
  test(`${path}: cursor rule, own components, viewer first`, async ({ page }) => {
    await open(page, path);
    await page.getByTestId("page-title").waitFor();
    // Data loaded: no skeleton left.
    await expect(page.getByTestId("skeleton")).toHaveCount(0);
    expect(await cursorOffenders(page)).toEqual([]);
    expect(await nativeControls(page)).toEqual([]);
    expect(await directFileLinks(page)).toEqual([]);
  });
}

test("applications: the open record panel follows the rules (its files open in the viewer: applications.spec)", async ({ page }) => {
  await open(page, "/applications");
  await page.getByTestId("skeleton").first().waitFor({ state: "detached" }).catch(() => {});
  await page.locator("[data-testid=application-row], tbody tr").first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await cursorOffenders(page)).toEqual([]);
  expect(await nativeControls(page)).toEqual([]);
  expect(await directFileLinks(page)).toEqual([]);
});

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
  // Off-screen at the readable zoom (PM3 S6) until Ba pans: dispatch the click on the node.
  await page.getByTestId("node-scan").dispatchEvent("click");
  await page.getByTestId("step-drawer").waitFor();
  expect(await cursorOffenders(page)).toEqual([]);
});
