import { expect, test, type Page } from "@playwright/test";
import { open } from "./helpers";

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
    await expect(research.getByRole("radio", { name: "Codex" })).toHaveAttribute("aria-checked", "true");
    await expect(research.getByRole("img", { name: /^Trust level L2/ })).toBeVisible();
    await expect(research).toContainText("Track record: 41 tasks · 95% self-check pass");
    await expect(research.getByTestId("bot-prompt-version")).toHaveText("prompt v2");
    await expect(research.getByTestId("bot-residual-risk")).toContainText("owner decision E1");
  });

  test("Apply's and CV's engine switches are disabled with the reason (§4.4, §6.2)", async ({ page }) => {
    for (const name of ["apply", "cv"]) {
      await expect(card(page, name).getByRole("radio", { name: "Codex" })).toBeDisabled();
      await expect(card(page, name).getByTestId("bot-engine-lock")).toContainText("Locked to Claude");
    }
    await expect(card(page, "cv").getByTestId("bot-engine-lock")).toHaveText("Locked to Claude: CV edits Figma; its Drafts-only guard runs only on Claude.");
  });

  test("switches Research's engine with the mouse and Lead's with the arrow keys", async ({ page }) => {
    await card(page, "research").getByRole("radio", { name: "Claude" }).click();
    await expect(page.getByTestId("toast").filter({ hasText: "Research now runs on Claude. Queued tasks keep their engine." })).toBeVisible();
    await expect(card(page, "research").getByRole("radio", { name: "Claude" })).toHaveAttribute("aria-checked", "true");

    await card(page, "lead").getByRole("radio", { name: "Claude" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(card(page, "lead").getByRole("radio", { name: "Codex" })).toHaveAttribute("aria-checked", "true");
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

  test("an unknown bot is not found", async ({ page }) => {
    await open(page, "/bots/nobody");
    await expect(page.getByText("Not found")).toBeVisible();
  });
});
