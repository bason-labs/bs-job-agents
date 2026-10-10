import path from "node:path";
import { expect, test } from "@playwright/test";
import { open, presetTheme } from "./helpers";

// Light/dark render check (spec §12 "light/dark screenshot checks").
// Images are only written to e2e/__screenshots__/ (committed for reviewers)
// when UPDATE_SCREENSHOTS=1, so a normal run never dirties the tree:
//   pnpm --filter @bs-job-agents/web e2e:screenshots

const OUT = path.join(__dirname, "__screenshots__");
const WRITE = process.env.UPDATE_SCREENSHOTS === "1";

const SHOTS: Array<{ name: string; route: string; fullPage: boolean }> = [
  { name: "chat", route: "/chat", fullPage: false },
  { name: "dev-components", route: "/dev/components", fullPage: true },
];

test.use({ viewport: { width: 1440, height: 900 } });

for (const theme of ["light", "dark"] as const) {
  for (const shot of SHOTS) {
    test(`${shot.route} renders in ${theme}`, async ({ page }) => {
      await presetTheme(page, theme);
      await open(page, shot.route);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page.evaluate(() => document.fonts.ready);
      const image = await page.screenshot({
        fullPage: shot.fullPage,
        animations: "disabled",
        path: WRITE ? path.join(OUT, `${shot.name}-${theme}.png`) : undefined,
      });
      expect(image.byteLength).toBeGreaterThan(10_000);
    });
  }
}
