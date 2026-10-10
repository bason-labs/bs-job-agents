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

/**
 * Runs `fn` against the browser's mock orchestrator (window.__bsjaMock, mock mode only), e.g. to
 * approve a card from a chat test without going through the Review screen.
 */
export async function withMock<T>(page: Page, fn: (mock: MockHandle) => T | Promise<T>): Promise<T> {
  await page.waitForFunction(() => Boolean((window as unknown as { __bsjaMock?: unknown }).__bsjaMock));
  return page.evaluate(`(${fn.toString()})(window.__bsjaMock)`) as Promise<T>;
}

/** The parts of the mock backend e2e tests call (lib/api/mock/backend.ts). */
export interface MockHandle {
  simulate(kind: string): void;
  approve(jobId: string, input: { cvVersionId: string; introText: string | null }): Promise<{ taskId: string | null }>;
  idle(): Promise<void>;
}

/** Opens the Simulate menu (mock mode) and picks an item. */
export async function simulate(page: Page, label: RegExp | string) {
  await page.getByTestId("simulate-menu").click();
  await page.getByRole("menuitem", { name: label }).click();
}

/** Text of the option a Select trigger points at (aria-activedescendant). */
export async function activeOptionText(page: Page, triggerTestId: string): Promise<string | null> {
  return page.getByTestId(triggerTestId).evaluate((el) => {
    const id = el.getAttribute("aria-activedescendant");
    return id ? (document.getElementById(id)?.textContent?.trim() ?? null) : null;
  });
}
