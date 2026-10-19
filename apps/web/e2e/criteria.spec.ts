import { expect, test } from "@playwright/test";
import { open, withMock, type MockHandle } from "./helpers";

// UC-21b: edit the Search Profile, on the mock orchestrator (lib/api/mock).

test.beforeEach(async ({ page }) => {
  await open(page, "/criteria");
});

test("edits lists, toggles and sliders, then saves a new version (UC-21b)", async ({ page }) => {
  await expect(page.getByTestId("criteria-header")).toHaveText(
    "Active profile v3 · updated 2026-10-10 · used by scheduled scans and chat requests",
  );
  await expect(page.getByTestId("criteria-header").getByRole("link", { name: "scheduled scans" })).toHaveAttribute("href", "/schedules");

  await page.getByRole("textbox", { name: "Add to Locations" }).fill("Đà Nẵng");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("criteria-locations")).toContainText("Đà Nẵng");
  await expect(page.getByText("unsaved changes")).toBeVisible();

  await page.getByRole("button", { name: "Remove PHP" }).click();
  await expect(page.getByTestId("criteria-excludeKeywords")).not.toContainText("PHP");

  const linkedin = page.getByTestId("criteria-sources").getByRole("button", { name: "LinkedIn" });
  await expect(linkedin).toHaveAttribute("aria-pressed", "true");
  await linkedin.click();
  await expect(linkedin).toHaveAttribute("aria-pressed", "false");

  // Own slider: ←/→ keys move it (spec §11).
  const fit = page.getByTestId("criteria-fit").getByRole("slider");
  await fit.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("criteria-fit-value")).toHaveText("65");

  await page.getByTestId("criteria-save").click();
  await expect(page.getByTestId("toast").filter({ hasText: "Search criteria saved as v4" })).toBeVisible();
  await expect(page.getByTestId("criteria-header")).toContainText("Active profile v4 · updated just now");
  await expect(page.getByText("unsaved changes")).toBeHidden();
  await expect(page.getByTestId("criteria-versions").getByRole("listitem").first()).toContainText("v4");
  await expect(page.getByTestId("criteria-versions").getByRole("listitem").first()).toContainText("active");
});

test("W5: sources in three groups, new ones off; a remote board shows the time-zone overlap field", async ({ page }) => {
  const sources = page.getByTestId("criteria-sources");
  await expect(page.getByTestId("criteria-sources-vietnam").locator("button[aria-pressed]")).toHaveText(["TopCV", "ITviec", "VietnamWorks"]);
  await expect(page.getByTestId("criteria-sources-remote").locator("button[aria-pressed]")).toHaveText(["Remote OK", "We Work Remotely", "Remotive", "Jobspresso"]);
  await expect(page.getByTestId("criteria-sources-global").locator("button[aria-pressed]")).toHaveText(["LinkedIn", "Wellfound", "Upwork"]);
  for (const name of ["VietnamWorks", "Remote OK", "We Work Remotely", "Remotive", "Jobspresso", "Wellfound", "Upwork"]) {
    await expect(sources.getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "false");
  }
  await expect(page.getByTestId("criteria-timezone-overlap")).toHaveCount(0);

  const remoteOk = sources.getByRole("button", { name: "Remote OK", exact: true });
  await remoteOk.click();
  await expect(remoteOk).toHaveAttribute("aria-pressed", "true");
  const overlap = page.getByLabel("Time-zone overlap (remote boards)");
  await expect(overlap).toBeVisible();

  // A value that is neither a region nor a UTC offset is refused.
  await overlap.fill("somewhere");
  await page.getByTestId("criteria-save").click();
  await expect(page.getByRole("alert").filter({ hasText: "Use a region (Asia, APAC, Europe…)" })).toBeVisible();

  await overlap.fill("UTC+7 ±3h");
  await sources.getByRole("button", { name: "Upwork", exact: true }).click();
  await page.getByTestId("criteria-save").click();
  await expect(page.getByTestId("toast").filter({ hasText: "Search criteria saved as v4" })).toBeVisible();
  await expect(overlap).toHaveValue("UTC+7 ±3h");
  await expect(sources.getByRole("button", { name: "Upwork", exact: true })).toHaveAttribute("aria-pressed", "true");

  // Turning the remote boards off hides the field again (the saved value is kept).
  await remoteOk.click();
  await sources.getByRole("button", { name: "Upwork", exact: true }).click();
  await expect(page.getByTestId("criteria-timezone-overlap")).toHaveCount(0);
});

test("the fixed salary rule needs an amount, typed with thousands separators (§7.5, UC-12)", async ({ page }) => {
  await expect(page.getByTestId("criteria-salary-note")).toContainText("If a form makes salary required");
  await expect(page.getByTestId("criteria-salary-amount")).toHaveCount(0);

  await page.getByTestId("criteria-salary-policy").click();
  await expect(page.getByRole("listbox").getByRole("option")).toHaveText([
    "Leave blank when optional",
    "Write “Negotiable / Thỏa thuận”",
    "Use a fixed amount",
    "Ask me each time",
  ]);
  await page.getByRole("option", { name: "Use a fixed amount" }).click();
  const amount = page.getByLabel("Amount (VND)");
  await expect(amount).toBeVisible();

  await page.getByTestId("criteria-save").click();
  await expect(page.getByTestId("toast").filter({ hasText: "Enter the amount Apply should write" })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "Enter the amount Apply should write" })).toBeVisible();

  await amount.pressSequentially("30000000");
  await expect(amount).toHaveValue("30,000,000");
  await expect(page.getByRole("alert").filter({ hasText: "Enter the amount" })).toHaveCount(0);

  // The amount follows the currency.
  await page.getByTestId("criteria-currency").click();
  await page.getByRole("option", { name: "USD" }).click();
  await expect(page.getByLabel("Amount (USD)")).toHaveValue("30,000,000");

  await page.getByTestId("criteria-save").click();
  await expect(page.getByTestId("toast").filter({ hasText: "Search criteria saved as v4" })).toBeVisible();
  await expect(page.getByTestId("criteria-salary-note")).toHaveText("Apply writes this amount in the expected-salary field.");
});

test("needs at least one role, location and source (UC-21b b)", async ({ page }) => {
  await page.getByRole("button", { name: "Remove Frontend Engineer" }).click();
  await page.getByRole("button", { name: "Remove Software Engineer (React/Node)" }).click();
  await page.getByTestId("criteria-save").click();
  await expect(page.getByTestId("toast").filter({ hasText: "Need at least one role, location and source" })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "Add at least one role" })).toBeVisible();
  await expect(page.getByTestId("criteria-header")).toContainText("Active profile v3");

  // Fixing it clears the error.
  await page.getByRole("textbox", { name: "Add to Roles" }).fill("Frontend Engineer");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "Add at least one role" })).toHaveCount(0);
});

test("shows CV languages as a read-only note (§6.3)", async ({ page }) => {
  await expect(page.getByText("CV languages: English for English JDs; Vietnamese + English for Vietnamese JDs.")).toBeVisible();
});

test("before the first save (GET /criteria 404) the form starts empty and Save creates v1", async ({ page }) => {
  await open(page, "/schedules");
  await withMock(page, (mock: MockHandle) => {
    mock.state.profiles.length = 0;
  });
  await page.getByTestId("sidebar").getByRole("link", { name: "Search criteria" }).click();
  await expect(page.getByTestId("criteria-header")).toContainText("No search criteria yet · saving creates v1");
  await page.getByRole("textbox", { name: "Add to Roles" }).fill("Frontend Engineer");
  await page.keyboard.press("Enter");
  await page.getByRole("textbox", { name: "Add to Locations" }).fill("Ho Chi Minh City");
  await page.keyboard.press("Enter");
  await page.getByTestId("criteria-save").click();
  await expect(page.getByTestId("toast").filter({ hasText: "Search criteria saved as v1" })).toBeVisible();
  await expect(page.getByTestId("criteria-header")).toContainText("Active profile v1 · updated just now");
});

test("a criteria save in chat ('Save to my criteria') shows here as the next version", async ({ page }) => {
  await withMock(page, (mock: MockHandle) =>
    mock.request("PUT", "/criteria", {
      body: {
        roles: ["Frontend Engineer"],
        locations: ["Ho Chi Minh City", "Đà Nẵng"],
        workModes: ["onsite"],
        minSalary: null,
        currency: "VND",
        seniority: [],
        sources: ["topcv"],
        includeKeywords: [],
        excludeKeywords: [],
        excludeCompanies: [],
        companyTypes: [],
        languages: ["en"],
        maxJobs: 5,
        fitThreshold: 60,
        salaryPolicy: "blank_if_optional",
        salaryAmount: null,
      },
    }),
  );
  await page.getByTestId("sidebar").getByRole("link", { name: "Schedules" }).click();
  await expect(page.getByTestId("page-title")).toHaveText("Schedules");
  await page.getByTestId("sidebar").getByRole("link", { name: "Search criteria" }).click();
  await expect(page.getByTestId("criteria-header")).toContainText("Active profile v4");
  await expect(page.getByTestId("criteria-locations")).toContainText("Đà Nẵng");
});

test("API research §5.6: each toggle shows how the board is read; with a (simulated) LinkedIn API reader, its account API is approved, then revoked", async ({ page }) => {
  const linkedin = page.getByTestId("source-linkedin");
  await expect(page.getByTestId("source-remotive").getByTestId("source-access-label")).toHaveText("Public API");
  await expect(page.getByTestId("source-upwork").getByTestId("source-access-label")).toHaveText("Browser");
  // As in production: LinkedIn has no API reader, so it reads in the browser and has nothing to approve.
  await expect(linkedin.getByTestId("source-access-label")).toHaveText("Browser");
  await expect(linkedin.getByRole("button", { name: /Approve|Revoke/ })).toHaveCount(0);

  // Simulate an API reader for LinkedIn in the mock, then come back to the screen.
  await withMock(page, (mock: MockHandle) => {
    (mock.state as unknown as { sourceAccess?: unknown }).sourceAccess = { approvals: {}, tokens: [], readers: ["topcv", "itviec", "linkedin"] };
  });
  await page.getByTestId("sidebar").getByRole("link", { name: "Schedules" }).click();
  await expect(page.getByTestId("page-title")).toHaveText("Schedules");
  await page.getByTestId("sidebar").getByRole("link", { name: "Search criteria" }).click();
  await expect(linkedin.getByTestId("source-access-label")).toHaveText("Account API (needs approval) · Browser until approved");

  const approve = linkedin.getByRole("button", { name: "Approve the account API for LinkedIn" });
  await approve.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Approve the account API for LinkedIn?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Terms of use", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Account risk", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(approve).toBeFocused();

  await approve.click();
  await dialog.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByTestId("toast").filter({ hasText: "Approved the account API for LinkedIn" })).toBeVisible();
  await expect(linkedin.getByTestId("source-access-label")).toHaveText("Account API (token missing) · Browser until a token is set");
  await expect(linkedin.getByTestId("source-token-hint")).toContainText("Board tokens");

  await linkedin.getByRole("button", { name: "Revoke the account API for LinkedIn" }).click();
  await expect(linkedin.getByTestId("source-access-label")).toHaveText("Account API (needs approval) · Browser until approved");
});
