import { expect, test, type Page } from "@playwright/test";
import { open } from "../helpers";
import { resetOrchestrator } from "./live";

// E1 option A and rule 5 as the real orchestrator serves them (the repo's bots/*.json).

const card = (page: Page, name: string) => page.getByTestId(`bot-card-${name}`);

test.beforeEach(async () => {
  await resetOrchestrator();
});

test("E1 option A: Research runs on Claude with no residual-risk note; Lead, CV and Apply are locked to Claude", async ({ page }) => {
  await open(page, "/bots");
  await expect(page.getByTestId("bots-grid").locator("article")).toHaveCount(5);
  await expect(card(page, "research").getByRole("radio", { name: "Claude" })).toHaveAttribute("aria-checked", "true");
  await expect(card(page, "research").getByTestId("bot-residual-risk")).toHaveCount(0);
  for (const name of ["apply", "cv", "lead"]) {
    await expect(card(page, name).getByRole("radio", { name: "Codex" })).toBeDisabled();
    await expect(card(page, name).getByTestId("bot-engine-lock")).toContainText("Locked to Claude");
  }
  // The API refuses Lead on Codex too (PM3 M1), not only the disabled switch.
  const res = await page.request.patch("/api/bots/lead", {
    data: { engine: "codex" },
    headers: { "x-bsja-csrf": "1", origin: new URL(page.url()).origin },
  });
  expect(res.status()).toBe(403);
});
