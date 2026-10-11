import { expect, test, type Page } from "@playwright/test";
import { open, presetTheme, waitForHydration } from "./helpers";

// App shell (spec §11: sidebar, layout rule, theme) on placeholder routes.

const title = (page: Page) => page.getByTestId("page-title");

test("/ redirects to /chat", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page).toHaveTitle(/Chat \| bs-job-agents/);
  await expect(title(page)).toHaveText("Chat with Lead");
});

test("sidebar navigates to every route", async ({ page }) => {
  await open(page, "/chat");
  const sidebar = page.getByTestId("sidebar");
  const main = sidebar.getByRole("navigation", { name: "Main" });

  const navTargets: Array<[string, RegExp, string]> = [
    ["Flows", /\/flows$/, "Flows"],
    ["Review", /\/review$/, "Review queue"],
    ["Applications", /\/applications$/, "Applications"],
    ["Search criteria", /\/criteria$/, "Search criteria"],
    ["Schedules", /\/schedules$/, "Schedules"],
    ["Chat", /\/chat$/, "Chat with Lead"],
  ];
  for (const [label, url, heading] of navTargets) {
    const link = main.getByRole("link", { name: new RegExp(`^${label}`) });
    await link.click();
    await expect(page).toHaveURL(url);
    await expect(title(page)).toHaveText(heading);
    await expect(link).toHaveAttribute("aria-current", "page");
  }

  // Team: click a bot → direct chat.
  await sidebar.getByRole("link", { name: "Chat with Research" }).click();
  await expect(page).toHaveURL(/\/chat\/research$/);
  await expect(title(page)).toHaveText("Chat with Research");
  await expect(page.getByText("Direct chat with Research")).toBeVisible();
  await expect(main.getByRole("link", { name: /^Chat/ })).toHaveAttribute("aria-current", "page");

  // Team: ⚙ appears on hover → bot settings.
  const applyRow = sidebar.getByRole("listitem").filter({ has: page.getByRole("link", { name: "Chat with Apply" }) });
  const gear = applyRow.getByRole("link", { name: "Apply settings" });
  await expect(gear).toBeHidden();
  await applyRow.hover();
  await expect(gear).toBeVisible();
  await gear.click();
  await expect(page).toHaveURL(/\/bots\/apply$/);
  await expect(title(page)).toHaveText("Bots · Apply");

  await sidebar.getByRole("link", { name: "Manage" }).click();
  await expect(page).toHaveURL(/\/bots$/);
  await expect(title(page)).toHaveText("Bots");

  await sidebar.getByRole("link", { name: "# cv-brainstorm" }).click();
  await expect(page).toHaveURL(/\/rooms\/cv-brainstorm$/);
  await expect(title(page)).toHaveText("# cv-brainstorm");

  await sidebar.getByRole("link", { name: "Master CV" }).click();
  await expect(page).toHaveURL(/\/cv$/);
  await expect(title(page)).toHaveText("Master CV");
});

test("/chat/lead redirects to /chat, Lead's main chat", async ({ page }) => {
  const response = await page.goto("/chat/lead");
  expect(response?.ok()).toBe(true);
  await expect(page).toHaveURL(/\/chat$/);
  await waitForHydration(page);
  await expect(title(page)).toHaveText("Chat with Lead");
  const sidebar = page.getByTestId("sidebar");
  await expect(sidebar.getByRole("link", { name: "Chat with Lead" })).toHaveAttribute("href", "/chat");
  await expect(sidebar.getByRole("link", { name: "Chat with Lead" })).toHaveAttribute("aria-current", "page");
});

test("no screen links to the /dev/components gallery (it stays reachable by URL)", async ({ page }) => {
  const paths = ["/chat", "/chat/research", "/flows", "/flows/12", "/review", "/applications", "/criteria", "/schedules", "/bots", "/bots/apply", "/cv", "/rooms/cv-brainstorm"];
  for (const path of paths) {
    await open(page, path);
    await expect(page.locator('a[href^="/dev"]'), path).toHaveCount(0);
  }
  await open(page, "/dev/components");
  await expect(page.getByTestId("sidebar")).toHaveCount(0);
});

test("deep links render inside the shell", async ({ page }) => {
  await open(page, "/flows/12");
  await expect(title(page)).toHaveText("Flow · Job scan #12");
  await expect(page.getByTestId("sidebar").getByRole("link", { name: /^Flows/ })).toHaveAttribute("aria-current", "page");

  await open(page, "/chat/nobody");
  await expect(page.getByText("Not found")).toBeVisible();
});

test("sidebar shows review badge, live dots, trust badges and usage", async ({ page }) => {
  await open(page, "/chat");
  const sidebar = page.getByTestId("sidebar");
  await expect(sidebar.getByRole("link", { name: /^Review/ })).toContainText("3");
  // The mock's bots are idle until something runs (chat.spec.ts sees Research go "working").
  await expect(sidebar.getByRole("img", { name: "Idle" })).toHaveCount(5);
  // PM S9: only Apply carries the trust badge.
  await expect(sidebar.getByLabel("Trust level L1")).toHaveCount(1);
  await expect(sidebar.getByTestId("usage-claude")).toContainText("42%");
  await expect(sidebar.getByTestId("usage-chatgpt")).toContainText("18%");
});

test.describe("layout rule", () => {
  test.use({ viewport: { width: 1600, height: 900 } });

  test("constrained pages are centered; chat and flows are full width", async ({ page }) => {
    for (const path of ["/criteria", "/schedules", "/cv", "/bots", "/bots/apply", "/review", "/applications", "/rooms"]) {
      await open(page, path);
      const pageBox = (await page.getByTestId("page").boundingBox())!;
      const mainBox = (await page.locator("main").boundingBox())!;
      const left = pageBox.x - mainBox.x;
      const right = mainBox.x + mainBox.width - (pageBox.x + pageBox.width);
      expect(pageBox.width, path).toBeLessThan(mainBox.width - 100);
      expect(Math.abs(left - right), path).toBeLessThan(20); // allow for a scrollbar
    }
    for (const path of ["/chat", "/flows"]) {
      await open(page, path);
      await expect(page.getByTestId("page")).toHaveAttribute("data-width", "full");
      const pageBox = (await page.getByTestId("page").boundingBox())!;
      const mainBox = (await page.locator("main").boundingBox())!;
      expect(pageBox.width, path).toBeGreaterThan(mainBox.width - 2);
    }
  });
});

test.describe("theme", () => {
  test("toggle switches data-theme and persists across reloads without a flash", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    // Record the theme at the moment <body> is parsed, before any paint.
    await page.addInitScript(() => {
      const w = window as unknown as { __themeAtBody?: string | null };
      new MutationObserver((_, obs) => {
        if (document.body) {
          w.__themeAtBody = document.documentElement.getAttribute("data-theme");
          obs.disconnect();
        }
      }).observe(document, { childList: true, subtree: true });
    });
    await open(page, "/chat");
    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-theme", "light");

    await page.getByTestId("theme-toggle").click();
    await expect(html).toHaveAttribute("data-theme", "dark");
    expect(await page.evaluate(() => localStorage.getItem("bsja_theme"))).toBe("dark");

    await page.reload();
    await expect(html).toHaveAttribute("data-theme", "dark");
    expect(await page.evaluate(() => (window as unknown as { __themeAtBody?: string }).__themeAtBody)).toBe("dark");

    await page.getByTestId("theme-toggle").click();
    await expect(html).toHaveAttribute("data-theme", "light");
    await page.goto("/schedules");
    await expect(html).toHaveAttribute("data-theme", "light");
  });

  test("light and dark use different surfaces", async ({ page }) => {
    await presetTheme(page, "dark");
    await open(page, "/chat");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.getByTestId("theme-toggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(dark).not.toBe(light);
  });
});

test.describe("mobile", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("sidebar collapses into a drawer", async ({ page }) => {
    await open(page, "/chat");
    await expect(page.getByTestId("sidebar")).toBeHidden();
    await page.getByTestId("open-navigation").click();
    const drawer = page.getByTestId("sidebar-drawer");
    await expect(drawer).toBeVisible();
    await drawer.getByRole("link", { name: /^Schedules/ }).click();
    await expect(page).toHaveURL(/\/schedules$/);
    await expect(drawer).toBeHidden();
    await expect(title(page)).toHaveText("Schedules");
    // No horizontal page scroll at phone width.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test("PM3 S7: the page title stays readable next to the sample-data badge (no one-letter collapse)", async ({ page }) => {
    for (const path of ["/chat", "/applications", "/criteria"]) {
      await open(page, path);
      const box = await title(page).boundingBox();
      // At least a few words wide, and the whole title fits on its line (not "C…").
      expect(box!.width, path).toBeGreaterThan(60);
      expect(await title(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1), path).toBe(true);
    }
  });
});

test("PM3 S7: the app has a favicon (the J brand mark), so browsers stop asking for a missing one", async ({ page }) => {
  await open(page, "/chat");
  const href = await page.locator('link[rel="icon"]').first().getAttribute("href");
  expect(href).toMatch(/icon/);
  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toMatch(/svg/);
  expect(await res.text()).toContain(">J<");
});
