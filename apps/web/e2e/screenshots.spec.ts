import { expect, test } from "@playwright/test";
import { open, presetTheme } from "./helpers";
import { FROZEN_NOW, SCREENSHOT_OPTIONS } from "./screenshot-options";

// Light/dark screenshot comparisons (spec §12 "light/dark screenshot checks", PM3 S10): each main
// screen is compared with its committed baseline in e2e/__screenshots__/<name>-<theme>.png.
// Deterministic: the mock backend's seeded data, a frozen clock, the self-hosted fonts (wait for
// document.fonts), animations off, a fixed viewport. After an intended UI change, review the diff
// in the Playwright report, then refresh the baselines with
//   pnpm --filter @bs-job-agents/web e2e:screenshots
// Baselines are taken on macOS (Ba's Mac); another OS renders fonts differently.

const SHOTS: Array<{ name: string; route: string; fullPage: boolean; ready?: string }> = [
  { name: "chat", route: "/chat", fullPage: false, ready: "[data-testid=run-card] li" },
  { name: "flows-run", route: "/flows/12", fullPage: false, ready: "[data-testid=node-record-103]" },
  { name: "review", route: "/review", fullPage: false, ready: "[data-testid=cv-preview]" },
  { name: "dev-components", route: "/dev/components", fullPage: true },
];

test.use({ viewport: { width: 1440, height: 900 } });

for (const theme of ["light", "dark"] as const) {
  for (const shot of SHOTS) {
    test(`${shot.route} matches its ${theme} baseline`, async ({ page }) => {
      await page.clock.setFixedTime(FROZEN_NOW);
      await presetTheme(page, theme);
      await open(page, shot.route);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      if (shot.ready) await page.locator(shot.ready).first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`${shot.name}-${theme}.png`, { ...SCREENSHOT_OPTIONS, fullPage: shot.fullPage });
    });
  }
}
