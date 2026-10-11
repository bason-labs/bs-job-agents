import { expect, test, type Page } from "@playwright/test";
import { open } from "./helpers";

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

test("answers CV's question with a new fact (§6.1 missing facts)", async ({ page }) => {
  const request = page.getByTestId("fact-request");
  await expect(request).toContainText("CV asks: “Have you used GraphQL in a project?” NovaPay asks for it");
  await request.getByRole("button", { name: "Add a fact" }).click();
  await expect(page.getByTestId("fact-request")).toHaveCount(0);
  await expect(editor(page).getByLabel("Fact id")).toHaveValue("skill-2");
  await editor(page).getByLabel("Text (English)").fill("GraphQL (Apollo Client) — used at Aegona");
  await page.getByTestId("cv-save").click();
  await expect(page.getByTestId("cv-header")).toContainText("Master version v8.");
  await expect(page.locator('[data-testid="fact"][data-fact-id="skill-2"]')).toContainText("GraphQL (Apollo Client) — used at Aegona");
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

test("“No, I don't” closes CV's question without adding a fact", async ({ page }) => {
  await page.getByTestId("fact-request").getByRole("button", { name: "No, I don't" }).click();
  await expect(page.getByTestId("fact-request")).toHaveCount(0);
  await expect(page.getByTestId("toast").filter({ hasText: "CV goes on without GraphQL" })).toBeVisible();
  await expect(page.getByTestId("fact")).toHaveCount(7);
});
