import { expect, test, type Page } from "@playwright/test";
import { open, withMock, type MockHandle } from "./helpers";

// §11 Bots, UC-19 promotion, §5.3 trust and demotion, PM S10/S14/S21/S25 rules.

const card = (page: Page, name: string) => page.getByTestId(`bot-card-${name}`);

test.describe("Bots grid", () => {
  test.beforeEach(async ({ page }) => {
    await open(page, "/bots");
  });

  test("shows each bot's role, engine, trust, track record and prompt version in two columns", async ({ page }) => {
    await expect(page.getByTestId("page")).toHaveAttribute("data-width", "wide");
    const cards = page.getByTestId("bots-grid").locator("article");
    await expect(cards).toHaveCount(5);
    const [first, second] = [(await cards.nth(0).boundingBox())!, (await cards.nth(1).boundingBox())!];
    expect(Math.abs(first.y - second.y)).toBeLessThan(2); // side by side
    const research = card(page, "research");
    await expect(research).toContainText("Finds jobs, scores fit, profiles companies (read-only browser).");
    await expect(research.getByRole("radio", { name: "Claude" })).toHaveAttribute("aria-checked", "true");
    await expect(research.getByRole("img", { name: /^Trust level L2/ })).toBeVisible();
    await expect(research).toContainText("Track record: 41 tasks · 95% self-check pass");
    await expect(research.getByTestId("bot-prompt-version")).toHaveText("prompt v2");
    // E1 option A: Research on Claude has no residual-risk note.
    await expect(research.getByTestId("bot-residual-risk")).toHaveCount(0);
  });

  test("Apply's, CV's and Lead's engine switches are disabled with the reason (§4.4, §6.2, rule 5)", async ({ page }) => {
    for (const name of ["apply", "cv", "lead"]) {
      await expect(card(page, name).getByRole("radio", { name: "Codex" })).toBeDisabled();
      await expect(card(page, name).getByTestId("bot-engine-lock")).toContainText("Locked to Claude");
    }
    await expect(card(page, "cv").getByTestId("bot-engine-lock")).toHaveText("Locked to Claude: CV edits Figma; its Drafts-only guard runs only on Claude.");
  });

  test("switches Research's engine with the mouse and QA's with the arrow keys", async ({ page }) => {
    await card(page, "research").getByRole("radio", { name: "Codex" }).click();
    await expect(page.getByTestId("toast").filter({ hasText: "Research now runs on Codex. Queued tasks keep their engine." })).toBeVisible();
    await expect(card(page, "research").getByRole("radio", { name: "Codex" })).toHaveAttribute("aria-checked", "true");
    await expect(card(page, "research").getByTestId("bot-residual-risk")).toContainText("owner decision E1");

    await card(page, "qa").getByRole("radio", { name: "Codex" }).focus();
    await page.keyboard.press("ArrowLeft");
    await expect(card(page, "qa").getByRole("radio", { name: "Claude" })).toHaveAttribute("aria-checked", "true");
  });

  test("Apply's promotion suggestion can't be accepted in Phase 1, only dismissed (UC-19)", async ({ page }) => {
    const promo = card(page, "apply").getByTestId("bot-promotion");
    await expect(promo).toContainText("System suggests promoting Apply to L2 (10 approved in a row without edits).");
    await expect(promo.getByRole("button", { name: "Promote (disabled in Phase 1 for Apply)" })).toBeDisabled();
    await promo.getByRole("button", { name: "Dismiss" }).click();
    await expect(card(page, "apply").getByTestId("bot-promotion")).toHaveCount(0);
  });

  test("restores a demoted bot one level (§5.3)", async ({ page }) => {
    const demotion = card(page, "cv").getByTestId("bot-demotion");
    await expect(demotion).toContainText("Demoted from L2 to L1");
    await expect(card(page, "cv").getByRole("img", { name: /^Trust level L1/ })).toBeVisible();
    await demotion.getByRole("button", { name: "Restore to L2" }).click();
    await expect(page.getByTestId("toast").filter({ hasText: "CV restored to L2" })).toBeVisible();
    await expect(card(page, "cv").getByRole("img", { name: /^Trust level L2/ })).toBeVisible();
  });

  test("shows a bot's memory and deletes a note after confirming (PM S14)", async ({ page }) => {
    await card(page, "research").getByRole("button", { name: "Memory (2 notes)" }).click();
    const memory = card(page, "research").getByTestId("bot-memory");
    await expect(memory.getByRole("listitem")).toHaveText(['TopCV salary often hidden: read "Mức lương" field.', "LinkedIn: stop at 40 page views."]);
    await memory.getByRole("button", { name: "Delete memory note: LinkedIn: stop at 40 page views." }).click();
    await page.getByTestId("confirm-dialog").getByRole("button", { name: "Delete note" }).click();
    await expect(memory.getByRole("listitem")).toHaveCount(1);
    await expect(card(page, "research").getByRole("button", { name: "Memory (1 note)" })).toBeVisible();
  });

  test("each card links to the bot's settings", async ({ page }) => {
    await page.getByRole("main").getByRole("link", { name: "QA settings" }).click();
    await expect(page).toHaveURL(/\/bots\/qa$/);
    await expect(page.getByTestId("page-title")).toHaveText("Bots · QA");
  });
});

test.describe("Bot settings", () => {
  test("Apply's settings: locked engine, trust ladder, enable switch, memory", async ({ page }) => {
    await open(page, "/bots/apply");
    const apply = card(page, "apply");
    await expect(page.getByTestId("bot-card-research")).toHaveCount(0);
    await expect(apply.getByRole("radio", { name: "Codex" })).toBeDisabled();
    await expect(apply.getByRole("list", { name: "Trust levels" }).getByRole("listitem")).toHaveCount(3);
    await expect(apply.getByRole("list", { name: "Trust levels" }).locator('[aria-current="true"]')).toContainText("L1");
    await expect(apply.getByTestId("bot-memory")).toContainText("TopCV: upload limit 5MB.");

    await apply.getByRole("switch").click();
    await expect(page.getByTestId("toast").filter({ hasText: "Apply disabled — Lead won't assign it new tasks" })).toBeVisible();
    await expect(apply).toContainText("disabled");

    await apply.getByRole("link", { name: "Chat with Apply →" }).click();
    await expect(page).toHaveURL(/\/chat\/apply$/);
  });

  test("picks a model for the bot's engine and goes back to the default (live run 1)", async ({ page }) => {
    await open(page, "/bots/qa");
    const qa = card(page, "qa");
    const field = qa.getByRole("combobox", { name: "Model" });
    await field.fill("sonnet");
    await expect(qa.getByTestId("bot-model-error")).toHaveText("sonnet is a model for Claude; QA runs on Codex.");
    await expect(qa.getByRole("button", { name: "Save model" })).toBeDisabled();
    await field.fill("gpt-5-codex");
    await qa.getByRole("button", { name: "Save model" }).click();
    await expect(page.getByTestId("toast").filter({ hasText: "QA now uses gpt-5-codex" })).toBeVisible();
    await expect(field).toHaveValue("gpt-5-codex");
    await qa.getByRole("button", { name: "Use default" }).click();
    await expect(page.getByTestId("toast").filter({ hasText: "QA uses the default model again" })).toBeVisible();
    await expect(field).toHaveValue("");
  });

  test("an unknown bot is not found", async ({ page }) => {
    await open(page, "/bots/nobody");
    await expect(page.getByText("Not found")).toBeVisible();
  });
});

test.describe("Workflow proposals (rule 3)", () => {
  test("Lead's proposals: approve saves a workflow and starts nothing; dismiss only marks it", async ({ page }) => {
    await open(page, "/bots");
    const section = page.getByTestId("workflow-proposals");
    await expect(section.getByTestId("workflow-proposal")).toHaveCount(1);
    await withMock(page, (mock: MockHandle) => mock.simulate("workflow-proposal"));
    await expect(section.getByTestId("workflow-proposal")).toHaveCount(2);

    const weekly = section.getByTestId("workflow-proposal").filter({ hasText: "weekly-remote-react" });
    await expect(weekly.getByTestId("workflow-proposal-summary")).toHaveText("preset of job-scan · workModes: remote · includeKeywords: React, Next.js · maxJobs: 5");
    await weekly.getByRole("button", { name: "Approve (save only)" }).click();
    await expect(page.getByTestId("toast").filter({ hasText: "Saved weekly-remote-react v1. Nothing was started; ask Lead to run it." })).toBeVisible();
    await expect(weekly).toHaveAttribute("data-status", "approved");
    await expect(weekly).toContainText("saved v1");

    const danang = section.getByTestId("workflow-proposal").filter({ hasText: "scan-da-nang" });
    await danang.getByRole("button", { name: "Dismiss" }).click();
    await expect(danang).toHaveAttribute("data-status", "dismissed");
    await expect(section.getByRole("button", { name: /Approve|Dismiss/ })).toHaveCount(0);
    // Nothing ran (rule 3): the mock still has only its two seeded runs.
    expect(await withMock(page, (mock: MockHandle) => Object.keys((mock.state as unknown as { runs: object }).runs).length)).toBe(2);
  });
});
