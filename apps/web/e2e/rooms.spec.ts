import { expect, test, type Page } from "@playwright/test";
import { open } from "./helpers";

// UC-15: group room in discussion mode with @mention autocomplete.

const composer = (page: Page) => page.getByRole("combobox", { name: "Message #cv-brainstorm" });
const messages = (page: Page) => page.getByTestId("room-message");

test.beforeEach(async ({ page }) => {
  await open(page, "/rooms/cv-brainstorm");
});

test("@mention autocomplete with the keyboard; the mentioned bots answer (UC-15)", async ({ page }) => {
  await expect(page.getByTestId("page-title")).toHaveText("# cv-brainstorm");
  await expect(page.getByText("Discussion mode — bots answer only when @mentioned and never take actions here.")).toBeVisible();
  await expect(messages(page)).toHaveCount(3);

  await composer(page).click();
  await page.keyboard.type("@");
  const list = page.getByTestId("mention-list");
  await expect(list.getByRole("option")).toHaveCount(5);
  await page.keyboard.type("q");
  await expect(list.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(composer(page)).toHaveValue("@QA ");
  await expect(list).toBeHidden();

  await page.keyboard.type("and @r");
  await page.keyboard.press("Tab");
  await expect(composer(page)).toHaveValue("@QA and @Research ");
  await page.keyboard.type("which JDs mention LLMs?");
  await page.keyboard.press("Enter");

  await expect(composer(page)).toHaveValue("");
  await expect(messages(page)).toHaveCount(4);
  await expect(messages(page).nth(3)).toHaveAttribute("data-author", "ba");
  await expect(page.getByTestId("room-waiting")).toContainText("QA, Research are answering…");
  await expect(messages(page).nth(4)).toHaveAttribute("data-author", "qa");
  await expect(messages(page).nth(5)).toHaveAttribute("data-author", "research");
  await expect(messages(page).nth(5)).toContainText("I can pull 3 example JDs");
  await expect(page.getByTestId("room-waiting")).toBeHidden();
});

test("chooses a mention with the mouse, and Esc closes the list", async ({ page }) => {
  await composer(page).click();
  await page.keyboard.type("@");
  await page.getByTestId("mention-list").getByRole("option", { name: /^CV/ }).click();
  await expect(composer(page)).toHaveValue("@CV ");
  await expect(composer(page)).toBeFocused();
  await page.keyboard.type("@");
  await expect(page.getByTestId("mention-list")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("mention-list")).toBeHidden();
});

test("a message without a mention goes to no bot", async ({ page }) => {
  await composer(page).fill("thinking out loud");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("status").filter({ hasText: "No bot mentioned — type @ to ask a specific bot." })).toBeVisible();
  await expect(page.getByTestId("room-waiting")).toHaveCount(0);
});

test("an unknown room is not found", async ({ page }) => {
  await open(page, "/rooms/nope");
  await expect(page.getByText("Not found")).toBeVisible();
});
