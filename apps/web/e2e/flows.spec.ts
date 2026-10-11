import { expect, test, type Page } from "@playwright/test";
import { open } from "./helpers";

// Flows (spec §11 Flow canvas) on the mock orchestrator: the runs list, UC-22 step drawer,
// live updates over the event feed, UC-23 run controls.

const node = (page: Page, testId: string) => page.getByTestId(testId);

test("the runs list opens a run's canvas", async ({ page }) => {
  await open(page, "/flows");
  const rows = page.getByTestId("run-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("Job scan #12");
  await expect(rows.first()).toContainText("Waiting");
  await expect(rows.nth(1)).toContainText("Apply to link #11");
  await rows.first().click();
  await expect(page).toHaveURL(/\/flows\/12$/);
  await expect(page.getByTestId("flow-canvas")).toBeVisible();
});

test("the canvas shows each step's status, per-job lanes, QA rounds and the locked Apply node", async ({ page }) => {
  await open(page, "/flows/12");
  await expect(node(page, "node-scan")).toHaveAttribute("data-status", "done");
  await expect(node(page, "node-scan")).toContainText("34 found → 21 new");
  await expect(node(page, "node-fit")).toContainText("Dedupe + fit score");
  await expect(node(page, "node-tailor-101")).toContainText("Round 1");
  await expect(node(page, "node-tailor-101")).toContainText("72 ✗");
  await expect(node(page, "node-review-101")).toHaveAttribute("data-status", "waiting");
  await expect(node(page, "node-apply-101")).toContainText("🔒 locked");
  await expect(page.getByText("QA fail → fixes → next round").first()).toBeVisible();
});

test("UC-22: a node opens the drawer with input, output, self-check, transcript, attempts, engine and prompt version", async ({ page }) => {
  await open(page, "/flows/12");
  await node(page, "node-scan").click();
  const drawer = page.getByTestId("step-drawer");
  await expect(drawer.getByRole("heading", { name: "Scan sources" })).toBeVisible();
  await expect(drawer).toContainText("Research ×3 · Codex");
  // The newest task (LinkedIn) is shown first: it took two attempts.
  await expect(drawer.getByRole("radio", { name: "LinkedIn" })).toHaveAttribute("aria-checked", "true");
  await expect(drawer.getByTestId("drawer-attempt")).toContainText("2 of 2");
  await expect(drawer.getByTestId("drawer-prompt")).toContainText("v2");
  await expect(drawer.getByTestId("drawer-duration")).toContainText("6m 35s");
  await expect(drawer.getByTestId("drawer-input")).toContainText('"source": "linkedin"');
  await expect(drawer.getByTestId("drawer-output")).toContainText("1 JobCandidate · 13 page views");
  await expect(drawer.getByTestId("drawer-selfcheck")).toContainText("Every job has a reachable URL");
  await expect(drawer.getByTestId("transcript")).toContainText("Attempt 1 timed out after 600 s");
  await drawer.getByRole("radio", { name: "TopCV" }).click();
  await expect(drawer.getByTestId("drawer-attempt")).toContainText("1 of 2");
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();

  // A gate lists CV and QA per round; Apply can never be re-run (UC-23).
  await node(page, "node-tailor-102").click();
  await expect(drawer.getByRole("radio", { name: "VI · Round 2 · QA" })).toBeVisible();
  await expect(drawer.getByRole("button", { name: /SAOVIETTECH_FRONTEND_VI_v2\.pdf/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await node(page, "node-apply-101").click();
  await expect(drawer.getByRole("button", { name: "Re-run step" })).toBeDisabled();
  await expect(drawer).toContainText("Apply is never re-run; approve the card again instead.");
});

test("a run started from chat fills its canvas live; the drawer streams the transcript", async ({ page }) => {
  await open(page, "/chat");
  await page.getByRole("textbox", { name: "Message Lead" }).fill("Find frontend jobs in HCM");
  await page.keyboard.press("Enter");
  await page.locator('[data-testid=run-card][data-run="13"]').getByRole("link", { name: /Open flow/ }).click();
  await expect(page).toHaveURL(/\/flows\/13$/);
  await expect(node(page, "node-scan")).toHaveAttribute("data-status", "running");
  await node(page, "node-scan").click();
  await expect(page.getByTestId("transcript")).toContainText("search results");
  await page.keyboard.press("Escape");
  await expect(node(page, "node-review-201")).toHaveAttribute("data-status", "waiting", { timeout: 30_000 });
  await expect(node(page, "node-scan")).toHaveAttribute("data-status", "done");
});

test("UC-23: pause and resume a run; cancel asks first", async ({ page }) => {
  await open(page, "/flows/12");
  const header = page.getByText("Job scan #12", { exact: true }).locator("..");
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(header.locator("[data-status]")).toHaveAttribute("data-status", "paused");
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(header.locator("[data-status]")).toHaveAttribute("data-status", "waiting");
  await page.getByRole("button", { name: "Cancel run" }).click();
  const confirm = page.getByTestId("confirm-dialog");
  await expect(confirm).toContainText("Cancel Job scan #12?");
  await confirm.getByRole("button", { name: "Cancel run" }).click();
  await expect(header.locator("[data-status]")).toHaveAttribute("data-status", "cancelled");
  await expect(page.getByRole("button", { name: "Pause" })).toBeDisabled();
  await expect(node(page, "node-review-101")).toHaveAttribute("data-status", "cancelled");
});
