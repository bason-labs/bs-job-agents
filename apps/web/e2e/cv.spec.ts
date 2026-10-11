import { expect, test, type Page } from "@playwright/test";
import { open, withMock, type MockHandle } from "./helpers";

// UC-20: Ba edits master CV data; saving bumps the master version.

const editor = (page: Page) => page.getByTestId("fact-editor");

test.beforeEach(async ({ page }) => {
  await open(page, "/cv");
});

test("edits a fact's EN/VI text and tags, then saves a new master version (UC-20)", async ({ page }) => {
  await expect(page.getByTestId("cv-header")).toContainText("Master version v7.");
  await expect(page.getByTestId("fact")).toHaveCount(7);

  await page.getByRole("button", { name: "Edit grad-2" }).click();
  await editor(page).getByLabel("Text (English)").fill("Owned a multi-country purchase order system and invoice extraction workflow for finance teams.");
  await editor(page).getByLabel("Text (Vietnamese, optional)").fill("Phụ trách hệ thống đặt hàng đa quốc gia và quy trình trích xuất hóa đơn.");
  await editor(page).getByRole("textbox", { name: "Add to grad-2 tags" }).fill("ownership");
  await page.keyboard.press("Enter");
  await expect(page.getByText("unsaved changes")).toBeVisible();
  await editor(page).getByRole("button", { name: "Done" }).click();

  const fact = page.locator('[data-testid="fact"][data-fact-id="grad-2"]');
  await expect(fact).toContainText("Owned a multi-country purchase order system");
  await expect(fact).toContainText("VIPhụ trách hệ thống");
  await expect(fact).toContainText("ownership");

  await page.getByTestId("cv-save").click();
  await expect(page.getByTestId("toast").filter({ hasText: "Master CV saved as v8 — review cards built on v7 will offer to regenerate." })).toBeVisible();
  await expect(page.getByTestId("cv-header")).toContainText("Master version v8.");
  await expect(page.getByText("unsaved changes")).toBeHidden();
  await expect(page.getByTestId("cv-versions").getByRole("listitem").first()).toContainText("v8");
});

const ANSWER = "Yes, I used GraphQL with Apollo Client at Aegona.";

test("answers CV's question in free text: CV adds the fact, with Undo (owner request 2026-10-11)", async ({ page }) => {
  const request = page.getByTestId("fact-request");
  await expect(request).toContainText("CV asks: “Have you used GraphQL in a project?” NovaPay asks for it");
  await request.getByPlaceholder("Answer in your own words (EN or VI)…").fill(ANSWER);
  await request.getByRole("button", { name: "Add", exact: true }).click();
  await expect(request.getByTestId("fact-drafting")).toContainText("CV is writing the fact from your words…");

  const added = page.getByTestId("fact-added");
  await expect(added).toHaveAttribute("data-fact-id", "aeg-2");
  await expect(added).toContainText("Added");
  await expect(added).toContainText("I used GraphQL with Apollo Client at Aegona.");
  await expect(page.getByTestId("fact-request")).toHaveCount(0);
  await expect(page.getByTestId("cv-header")).toContainText("Master version v8.");
  await expect(page.getByText("unsaved changes")).toBeHidden();

  await added.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByTestId("toast").filter({ hasText: "Undone — master CV restored as v9." })).toBeVisible();
  await expect(page.getByTestId("fact-added")).toHaveCount(0);
  await expect(page.locator('[data-testid="fact"][data-fact-id="aeg-2"]')).toHaveCount(0);
  await expect(page.getByTestId("fact-request")).toHaveCount(1);
});

test("Edit on an added fact opens the fact editor", async ({ page }) => {
  const request = page.getByTestId("fact-request");
  await request.getByPlaceholder("Answer in your own words (EN or VI)…").fill(ANSWER);
  await request.getByPlaceholder("Answer in your own words (EN or VI)…").press("Control+Enter");
  await page.getByTestId("fact-added").getByRole("button", { name: "Edit", exact: true }).click();
  await expect(editor(page).getByLabel("Fact id")).toHaveValue("aeg-2");
});

test("adds facts from the free-text box", async ({ page }) => {
  const box = page.getByTestId("fact-free-text");
  await box.getByPlaceholder(/Tell me something new about your experience/).fill("I mentor two junior developers at Gradion");
  await box.getByRole("button", { name: "Add facts" }).click();
  await expect(page.getByTestId("fact-added")).toContainText("I mentor two junior developers at Gradion");
  await expect(page.getByTestId("cv-header")).toContainText("Master version v8.");
  await expect(page.getByTestId("retailor-banner")).toHaveCount(0);
});

test("after answering, re-tailors the CVs of the jobs that asked", async ({ page }) => {
  const request = page.getByTestId("fact-request");
  await request.getByPlaceholder("Answer in your own words (EN or VI)…").fill(ANSWER);
  await request.getByRole("button", { name: "Add", exact: true }).click();
  const banner = page.getByTestId("retailor-banner");
  await expect(banner).toContainText("Re-tailor CVs for: NovaPay");
  await banner.getByRole("button", { name: "Re-tailor CVs" }).click();
  await expect(banner.getByTestId("retailor-results")).toContainText("NovaPay: CV is tailoring it again");
});

test("won't save a fact without text, or a duplicate id", async ({ page }) => {
  await page.getByRole("button", { name: "+ Add fact" }).click();
  await page.getByTestId("cv-save").click();
  await expect(page.getByTestId("toast").filter({ hasText: "Fix the highlighted facts before saving" })).toBeVisible();
  await expect(editor(page).getByRole("alert")).toHaveText("Write the fact's text");

  await editor(page).getByLabel("Text (English)").fill("Docker for local dev environments");
  await editor(page).getByLabel("Fact id").fill("grad-1");
  await page.getByTestId("cv-save").click();
  await expect(page.getByRole("alert").filter({ hasText: "duplicate fact id grad-1" })).toBeVisible();
  await expect(page.getByTestId("cv-header")).toContainText("Master version v7.");
});

test("a save based on an older version shows the reload banner (409 master_cv_changed)", async ({ page }) => {
  await page.getByRole("button", { name: "Edit grad-2" }).click();
  await editor(page).getByLabel("Text (English)").fill("Owned the purchase order system.");
  await editor(page).getByRole("button", { name: "Done" }).click();
  // Another tab saves v8 meanwhile.
  await withMock(page, async (mock: MockHandle) => {
    const m = mock.state.masterCv as { cv: unknown };
    await mock.request("PUT", "/master-cv", { body: m.cv });
  });
  await page.getByTestId("cv-save").click();
  const banner = page.getByTestId("cv-conflict");
  await expect(banner).toContainText("The master CV changed since you opened it (now v8)");
  await expect(page.getByTestId("cv-save")).toBeDisabled();
  await banner.getByRole("button", { name: "Reload" }).click();
  await expect(page.getByTestId("cv-header")).toContainText("Master version v8.");
  await expect(banner).toBeHidden();
});

test("a question answered with a fact stays closed after a reload of the screen", async ({ page }) => {
  const request = page.getByTestId("fact-request");
  await request.getByPlaceholder("Answer in your own words (EN or VI)…").fill(ANSWER);
  await request.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByTestId("cv-header")).toContainText("Master version v8.");
  await page.getByTestId("sidebar").getByRole("link", { name: "Schedules" }).click();
  await expect(page.getByTestId("page-title")).toHaveText("Schedules");
  await page.getByTestId("sidebar").getByRole("link", { name: /Master CV/ }).click();
  await expect(page.getByTestId("cv-header")).toContainText("Master version v8.");
  await expect(page.getByTestId("fact-request")).toHaveCount(0);
});

test("“No, I don't” closes CV's question without adding a fact", async ({ page }) => {
  await page.getByTestId("fact-request").getByRole("button", { name: "No, I don't" }).click();
  await expect(page.getByTestId("fact-request")).toHaveCount(0);
  await expect(page.getByTestId("toast").filter({ hasText: "CV goes on without GraphQL" })).toBeVisible();
  await expect(page.getByTestId("fact")).toHaveCount(7);
});
