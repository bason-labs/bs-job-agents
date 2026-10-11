import { expect, test } from "@playwright/test";
import { open, presetTheme } from "./helpers";
import { FROZEN_NOW, SCREENSHOT_OPTIONS } from "./screenshot-options";

// Light/dark screenshot comparisons (spec §12, PM3 S10) for Applications, Search criteria,
// Schedules, Bots and Master CV. Same rules as screenshots.spec.ts; refresh the baselines with
// `pnpm --filter @bs-job-agents/web e2e:screenshots` after an intended change.

/** Tall viewports for the long forms, so the shot shows the whole screen. */
const SHOTS: Array<{ name: string; route: string; height: number }> = [
  { name: "applications", route: "/applications", height: 900 },
  { name: "criteria", route: "/criteria", height: 1700 },
  { name: "schedules", route: "/schedules", height: 900 },
  { name: "bots", route: "/bots", height: 1150 },
  { name: "cv", route: "/cv", height: 1750 },
];

for (const theme of ["light", "dark"] as const) {
  for (const shot of SHOTS) {
    test(`${shot.route} matches its ${theme} baseline`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: shot.height });
      await page.clock.setFixedTime(FROZEN_NOW);
      await presetTheme(page, theme);
      await open(page, shot.route);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.getByTestId("page")).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`${shot.name}-${theme}.png`, SCREENSHOT_OPTIONS);
    });
  }
}
