import { expect, test, type Page } from "@playwright/test";
import { open } from "../helpers";
import { resetOrchestrator } from "./live";

// E1 option A and rule 5 as the real orchestrator serves them (the repo's bots/*.json).

const card = (page: Page, name: string) => page.getByTestId(`bot-card-${name}`);

test.beforeEach(async () => {
  await resetOrchestrator();
});

test("E1 option A: Research runs on Claude with no residual-risk note; Lead and Apply are locked to Claude, CV is an opt-in", async ({ page }) => {
  await open(page, "/bots");
  await expect(page.getByTestId("bots-grid").locator("article")).toHaveCount(5);
  await expect(card(page, "research").getByRole("radio", { name: "Claude" })).toHaveAttribute("aria-checked", "true");
  await expect(card(page, "research").getByTestId("bot-residual-risk")).toHaveCount(0);
  for (const name of ["apply", "lead"]) {
    await expect(card(page, name).getByRole("radio", { name: "Codex" })).toBeDisabled();
    await expect(card(page, name).getByTestId("bot-engine-lock")).toContainText("Locked to Claude");
  }
  // Owner decision 2026-10-11: CV's switch is enabled; the API asks for acknowledgeRisk (409 without it).
  await expect(card(page, "cv").getByRole("radio", { name: "Codex" })).toBeEnabled();
  const cv = await page.request.patch("/api/bots/cv", {
    data: { engine: "codex" },
    headers: { "x-bsja-csrf": "1", origin: new URL(page.url()).origin },
  });
  expect(cv.status()).toBe(409);
  // The API refuses Lead on Codex too (PM3 M1), not only the disabled switch.
  const res = await page.request.patch("/api/bots/lead", {
    data: { engine: "codex" },
    headers: { "x-bsja-csrf": "1", origin: new URL(page.url()).origin },
  });
  expect(res.status()).toBe(403);
});
