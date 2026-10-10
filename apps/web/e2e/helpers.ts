import type { Page } from "@playwright/test";

/** Starts the page in a fixed theme (set before any app script runs). */
export async function presetTheme(page: Page, theme: "light" | "dark") {
  await page.addInitScript((t) => {
    try {
      localStorage.setItem("bsja_theme", t);
    } catch {
      // storage blocked: the OS scheme decides
    }
  }, theme);
}

/** Waits until React has hydrated (AppShell and the gallery set data-hydrated). */
export async function waitForHydration(page: Page) {
  await page.locator("[data-hydrated=true]").first().waitFor();
}

/** Opens a route and waits for hydration so clicks reach React handlers. */
export async function open(page: Page, path: string) {
  await page.goto(path);
  await waitForHydration(page);
}

/** Text of the option a Select trigger points at (aria-activedescendant). */
export async function activeOptionText(page: Page, triggerTestId: string): Promise<string | null> {
  return page.getByTestId(triggerTestId).evaluate((el) => {
    const id = el.getAttribute("aria-activedescendant");
    return id ? (document.getElementById(id)?.textContent?.trim() ?? null) : null;
  });
}
