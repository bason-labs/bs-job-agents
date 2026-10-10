import { expect, test, type Page } from "@playwright/test";
import { open } from "./helpers";

// UC-13 (status, submission record panel, file viewer) and UC-13b (export) on the
// fixture-backed Applications screen.

const row = (page: Page, company: string) => page.getByTestId("application-row").filter({ has: page.getByRole("button", { name: `Open ${company}'s submission record` }) });
const panel = (page: Page) => page.getByTestId("record-panel");
const viewer = (page: Page) => page.getByTestId("file-viewer");

/**
 * Esc closes the top dialog. Radix moves focus into a new dialog a moment (under one frame)
 * before it registers it as the top layer; an Esc in that gap reaches the dialog below (the
 * record panel). The top layer is the one whose content Radix gives `pointer-events: auto`,
 * so wait for that, as a person's key press always would.
 */
async function pressEscapeIn(page: Page, testId: string) {
  const dialog = page.getByTestId(testId);
  await expect(dialog).toHaveCSS("pointer-events", "auto");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
}

test.beforeEach(async ({ page }) => {
  await open(page, "/applications");
});

test("lists applications with imported, dry-run and needs-check states (UC-13, PM S25)", async ({ page }) => {
  await expect(page.getByTestId("page")).toHaveAttribute("data-width", "wide");
  await expect(page.getByTestId("application-row")).toHaveCount(7);
  await expect(page.getByTestId("applications-header")).toHaveText(
    "7 applications · stored on this Mac in data/ · click a row to see exactly what was sent",
  );
  await expect(row(page, "DEKON")).toContainText("imported");
  await expect(row(page, "Kite Labs")).toContainText("dry run");
  await expect(row(page, "Sao Việt Tech")).toHaveAttribute("data-status", "needs_check");
  await expect(row(page, "Sao Việt Tech").getByText("not captured")).toBeVisible();
  // A failed application has no status to pick.
  await expect(row(page, "Bluebird Software").getByRole("combobox")).toHaveCount(0);
  await expect(row(page, "Bluebird Software")).toContainText("Failed");
});

test("changes a status in the table and records it in the history (UC-13)", async ({ page }) => {
  const select = row(page, "NovaPay").getByRole("combobox", { name: "Status of NovaPay" });
  await expect(select).toHaveText("Submitted");
  await select.click();
  const list = page.getByRole("listbox");
  // Menus render in a portal, so the table never clips them (spec §11).
  await expect(list.getByRole("option")).toHaveText(["Submitted", "Interviewing", "Offer", "Rejected", "Withdrawn", "No response"]);
  await list.getByRole("option", { name: "Interviewing" }).click();
  await expect(select).toHaveText("Interviewing");
  await expect(panel(page)).toBeHidden();

  // Keyboard too: ↓ opens on the current option, ↓ moves, Enter chooses. (Move the pointer off
  // the list first: an option under a resting pointer becomes active when the list reopens.)
  await page.mouse.move(0, 0);
  await select.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(select).toHaveText("Offer");

  await page.getByRole("button", { name: "Open NovaPay's submission record" }).click();
  const history = panel(page).getByTestId("record-history").getByRole("listitem");
  await expect(history).toHaveCount(4);
  await expect(history.nth(2)).toContainText("interviewing");
  await expect(history.nth(3)).toContainText("offer");
});

test("a needs-check application is settled by hand (UC-11 c)", async ({ page }) => {
  const select = row(page, "Sao Việt Tech").getByRole("combobox");
  await select.click();
  await expect(page.getByRole("listbox").getByRole("option")).toHaveText(["Submitted", "Needs check", "Failed"]);
  await page.getByRole("option", { name: "Submitted" }).click();
  await expect(select).toHaveText("Submitted");
  await expect(row(page, "Sao Việt Tech")).toHaveAttribute("data-status", "submitted");

  // A dry run can never become submitted.
  await row(page, "Kite Labs").getByRole("combobox").click();
  await expect(page.getByRole("listbox").getByRole("option")).toHaveText(["Needs check", "Failed"]);
  await page.keyboard.press("Escape");
});

test("the record panel shows exactly what was sent, and files open in the viewer first (UC-13, §11)", async ({ page }) => {
  await row(page, "NovaPay").getByRole("cell").nth(1).click(); // any cell opens the record
  const p = panel(page);
  await expect(p.getByText("Submission record", { exact: true })).toBeVisible();
  await expect(p.getByRole("heading", { name: "NovaPay" })).toBeVisible();
  await expect(p.getByRole("link", { name: /itviec\.com\/it-jobs/ })).toHaveAttribute("target", "_blank");
  await expect(p.getByTestId("record-sha")).toHaveText("SHA-256: 6618f61f79198cbad7d0e3f7255575840b40d317878fab7393a1b7b6ffc589ec");
  const fields = p.getByTestId("record-fields");
  await expect(fields).toContainText("Notice period");
  await expect(fields).toContainText("saved answer");
  await expect(fields).toContainText("left blank — optional");
  await expect(p.getByRole("region", { name: "Consent" })).toContainText("I agree that the employer may process my personal data for recruitment.");
  await expect(p.getByTestId("record-approval")).toContainText("allowed sites: itviec.com");
  await expect(p).not.toContainText("tok_");

  // PDF: rendered with PDF.js, Download and "Open in Figma" inside the viewer.
  await p.getByRole("button", { name: "BA_HUYNH_NovaPay_EN_v1.pdf" }).click();
  await expect(viewer(page)).toBeVisible();
  await expect(viewer(page).getByRole("heading", { name: "BA_HUYNH_NovaPay_EN_v1.pdf" })).toBeVisible();
  await expect(viewer(page).getByTestId("pdf-page").first()).toHaveAttribute("data-rendered", "true");
  await expect(viewer(page).getByRole("link", { name: "Download" })).toHaveAttribute("download", "BA_HUYNH_NovaPay_EN_v1.pdf");
  await expect(viewer(page).getByRole("link", { name: /Open in Figma/ })).toHaveAttribute("href", /figma\.com/);
  await pressEscapeIn(page, "file-viewer");
  await expect(p).toBeVisible();

  // Image: the confirmation screenshot.
  await p.getByRole("button", { name: /Confirmation/ }).click();
  await expect(viewer(page).getByRole("img", { name: "NovaPay_confirmation.png" })).toBeVisible();
  await expect(viewer(page).getByTestId("file-viewer-subtitle")).toHaveText("· confirmation screenshot");
  await viewer(page).getByRole("button", { name: "Close" }).click();
  await expect(viewer(page)).toBeHidden();

  // Text: the frozen JD snapshot.
  await p.getByRole("button", { name: /JD snapshot/ }).click();
  await expect(viewer(page).getByTestId("file-viewer-text")).toContainText("Build product features with React/Next.js");
  await expect(viewer(page).getByTestId("file-viewer-subtitle")).toHaveText("· Frozen JD snapshot · captured 2026-10-10 15:39");
  await pressEscapeIn(page, "file-viewer");

  // Form: the fields as recorded.
  await p.getByRole("button", { name: "View as form" }).click();
  await expect(viewer(page).getByTestId("file-viewer-form")).toContainText("Form as recorded — the values Apply filled in");
  await expect(viewer(page).getByTestId("file-viewer-form")).toContainText("2 weeks");
  await pressEscapeIn(page, "file-viewer");

  await expect(p).toBeVisible();
  await pressEscapeIn(page, "record-panel");
  // Focus goes back to the row that opened the record.
  await expect(page.getByRole("button", { name: "Open NovaPay's submission record" })).toBeFocused();
});

test("an imported record shows its missing parts as “not captured” (UC-13)", async ({ page }) => {
  await page.getByRole("button", { name: "Open DEKON's submission record" }).click();
  const p = panel(page);
  await expect(p.getByText("Submission record · imported, partial")).toBeVisible();
  await expect(p.getByTestId("record-sha")).toHaveText("SHA-256: not captured");
  await expect(p.getByRole("button", { name: /Before submit/ })).toBeDisabled();
  await expect(p.getByRole("button", { name: /JD snapshot/ })).toContainText("not captured (applied before this app)");
  await expect(p.getByRole("region", { name: "Intro / cover text" })).toContainText("not captured");
  await expect(p.getByRole("button", { name: /Confirmation/ })).toContainText("Ứng tuyển việc làm thành công!");
});

test("the table's CV and screenshot links open the viewer, never a download (§11)", async ({ page }) => {
  await row(page, "SMARTBIT").getByRole("button", { name: "BA_HUYNH_SMARTBIT_Figma_EN.pdf" }).click();
  await expect(viewer(page).getByRole("heading", { name: "BA_HUYNH_SMARTBIT_Figma_EN.pdf" })).toBeVisible();
  await expect(panel(page)).toBeHidden();
  await pressEscapeIn(page, "file-viewer");
  await row(page, "SMARTBIT").getByRole("button", { name: "screenshot" }).click();
  await expect(viewer(page).getByRole("img", { name: "SMARTBIT_confirmation.png" })).toBeVisible();
});

test("Export all downloads a ZIP and shows the last export date (UC-13b)", async ({ page }) => {
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export all (ZIP)" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^job-agents-export_\d{4}-\d{2}-\d{2}\.zip$/);
  await expect(page.getByTestId("toast").filter({ hasText: /^Exported 6 applications → job-agents-export_/ })).toBeVisible();
  await expect(page.getByTestId("applications-header")).toContainText(/· last export \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test("a failed application can be applied to again, after a confirmation (pm-phase-1 §8)", async ({ page }) => {
  await page.getByRole("button", { name: "Open Bluebird Software's submission record" }).click();
  await expect(panel(page)).toContainText("No submission record — nothing was sent to the employer.");
  await panel(page).getByRole("button", { name: "Apply again…" }).click();
  const confirm = page.getByTestId("confirm-dialog");
  await expect(confirm).toContainText("Apply to Bluebird Software again?");
  await confirm.getByRole("button", { name: "Send to review" }).click();
  await expect(page.getByTestId("toast").filter({ hasText: "Bluebird Software is back in your review queue" })).toBeVisible();
});
