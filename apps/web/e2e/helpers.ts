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

const CLICKABLE = [
  "button",
  "a[href]",
  "[role=button]",
  "[role=tab]",
  "[role=radio]",
  "[role=switch]",
  "[role=checkbox]",
  "[role=combobox]",
  "[role=slider]",
  "[role=option]",
  "[role=menuitem]",
  "[data-clickable]",
].join(",");

/** Spec §11 cursor rule: visible clickable elements whose cursor is wrong (pointer, or not-allowed when disabled). */
export async function cursorOffenders(page: Page): Promise<string[]> {
  return page.evaluate((selector) => {
    const bad: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || style.visibility === "hidden" || style.display === "none") continue;
      const disabled = (el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true" || el.hasAttribute("data-disabled");
      const expected = disabled ? "not-allowed" : "pointer";
      if (style.cursor !== expected) bad.push(`${el.tagName.toLowerCase()}[${el.getAttribute("role") ?? ""}] "${(el.textContent ?? el.getAttribute("aria-label") ?? "").trim().slice(0, 30)}" → ${style.cursor}`);
    }
    return bad;
  }, CLICKABLE);
}

/** Own-components rule: browser-default select, range, checkbox, radio, number, date/time or visible file inputs. */
export async function nativeControls(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("select, input[type=range], input[type=checkbox], input[type=radio], input[type=number], input[type=date], input[type=time], input[type=file]"))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 1 && r.height > 1 && getComputedStyle(el).visibility !== "hidden";
      })
      .map((el) => el.outerHTML.slice(0, 80)),
  );
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
