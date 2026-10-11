import path from "node:path";
import { expect, test } from "@playwright/test";
import { open, presetTheme } from "./helpers";

// Light/dark render check (spec §12) for Applications, Search criteria, Schedules, Bots and
// Master CV. Like screenshots.spec.ts, images are only written to e2e/__screenshots__/ when
// UPDATE_SCREENSHOTS=1 (pnpm --filter @bs-job-agents/web e2e:screenshots runs both files).

const OUT = path.join(__dirname, "__screenshots__");
const WRITE = process.env.UPDATE_SCREENSHOTS === "1";

/** Tall viewports for the long forms, so the shot shows the whole screen. */
const SHOTS: Array<{ name: string; route: string; height: number }> = [
  { name: "applications", route: "/applications", height: 900 },
  { name: "criteria", route: "/criteria", height: 1700 },
  { name: "schedules", route: "/schedules", height: 900 },
  { name: "bots", route: "/bots", height: 1150 },
  { name: "cv", route: "/cv", height: 1450 },
];

for (const theme of ["light", "dark"] as const) {
  for (const shot of SHOTS) {
    test(`${shot.route} renders in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: shot.height });
      await presetTheme(page, theme);
      await open(page, shot.route);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.getByTestId("page")).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const image = await page.screenshot({
        animations: "disabled",
        path: WRITE ? path.join(OUT, `${shot.name}-${theme}.png`) : undefined,
      });
      expect(image.byteLength).toBeGreaterThan(10_000);
    });
  }
}
