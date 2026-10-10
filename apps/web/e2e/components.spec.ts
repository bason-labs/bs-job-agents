import { expect, test, type Page } from "@playwright/test";
import { activeOptionText, open } from "./helpers";

// Own-components rule (spec §11) and the UI end-to-end row of spec §12,
// exercised on the /dev/components gallery.

test.beforeEach(async ({ page }) => {
  await open(page, "/dev/components");
});

test.describe("Select", () => {
  test("keyboard: ↓ opens on the selected option, ↑/↓ move, Enter chooses", async ({ page }) => {
    const trigger = page.getByTestId("select-repeat");
    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("listbox")).toBeVisible();
    expect(await activeOptionText(page, "select-repeat")).toBe("Daily");

    await page.keyboard.press("ArrowDown");
    expect(await activeOptionText(page, "select-repeat")).toBe("Weekly");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown"); // wraps to the first option
    expect(await activeOptionText(page, "select-repeat")).toBe("Weekdays");
    await page.keyboard.press("ArrowUp");
    expect(await activeOptionText(page, "select-repeat")).toBe("Custom");

    await page.keyboard.press("Enter");
    await expect(page.getByRole("listbox")).toBeHidden();
    await expect(trigger).toHaveText("Custom");
    await expect(page.getByTestId("select-repeat-value")).toHaveText("value: custom");
    await expect(trigger).toBeFocused();
  });

  test("keyboard: Esc closes without changing; type-ahead jumps", async ({ page }) => {
    const trigger = page.getByTestId("select-repeat");
    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox")).toBeHidden();
    await expect(page.getByTestId("select-repeat-value")).toHaveText("value: daily");

    await page.keyboard.press("Enter"); // Enter on a closed select opens it
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.keyboard.press("w");
    expect(await activeOptionText(page, "select-repeat")).toBe("Weekly");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("select-repeat-value")).toHaveText("value: weekly");
  });

  test("mouse: click to open and choose; click outside closes", async ({ page }) => {
    const trigger = page.getByTestId("select-repeat");
    await trigger.click();
    await page.getByRole("option", { name: "Weekdays" }).click();
    await expect(page.getByTestId("select-repeat-value")).toHaveText("value: weekdays");
    await expect(page.getByRole("listbox")).toBeHidden();

    await trigger.click();
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.getByRole("heading", { name: "Component gallery" }).click();
    await expect(page.getByRole("listbox")).toBeHidden();
    await expect(page.getByTestId("select-repeat-value")).toHaveText("value: weekdays");
  });

  test("scrolls the selected option into view in a long list", async ({ page }) => {
    await page.getByTestId("select-time").click();
    const listbox = page.getByRole("listbox");
    const selected = listbox.getByRole("option", { name: "18:00" });
    await expect(selected).toHaveAttribute("aria-selected", "true");
    await expect
      .poll(async () => {
        const [list, opt] = await Promise.all([listbox.boundingBox(), selected.boundingBox()]);
        return !!list && !!opt && opt.y >= list.y && opt.y + opt.height <= list.y + list.height;
      })
      .toBe(true);
    // The list scrolled; it did not just open at the top.
    expect(await listbox.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  });

  test("is not clipped inside an overflow-hidden table", async ({ page }) => {
    const container = page.getByTestId("clipping-container");
    await page.getByTestId("select-in-table").click();
    const listbox = page.getByRole("listbox");
    await expect(listbox).toBeVisible();
    const [box, list] = await Promise.all([container.boundingBox(), listbox.boundingBox()]);
    expect(list!.y + list!.height).toBeGreaterThan(box!.y + box!.height);
    await listbox.getByRole("option", { name: "Offer" }).click();
    await expect(page.getByTestId("select-in-table")).toHaveText("Offer");
  });
});

test.describe("Slider", () => {
  test("arrow keys step the value", async ({ page }) => {
    const thumb = page.getByTestId("slider-fit").getByRole("slider");
    const value = page.getByTestId("slider-fit-value");
    await expect(value).toHaveText("60");
    await thumb.focus();
    await page.keyboard.press("ArrowRight");
    await expect(value).toHaveText("65");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(value).toHaveText("55");
    await page.keyboard.press("ArrowUp");
    await expect(value).toHaveText("60");
    await expect(thumb).toHaveAttribute("aria-valuenow", "60");
  });

  test("pointer drag moves the thumb", async ({ page }) => {
    const thumb = page.getByTestId("slider-max-jobs").getByRole("slider");
    const value = page.getByTestId("slider-max-jobs-value");
    const track = page.getByTestId("slider-max-jobs").locator("[data-orientation=horizontal]").first();
    // Raw mouse coordinates need the slider on screen.
    await track.scrollIntoViewIfNeeded();
    const t = (await thumb.boundingBox())!;
    const r = (await track.boundingBox())!;
    await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2);
    await page.mouse.down();
    await page.mouse.move(r.x + r.width * 0.75, r.y + r.height / 2, { steps: 8 });
    await page.mouse.move(r.x + r.width + 40, r.y + r.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(value).toHaveText("10");

    // Clicking the track jumps there.
    await page.mouse.click(r.x + 2, r.y + r.height / 2);
    await expect(value).toHaveText("1");
  });
});

test.describe("Checkbox and Switch", () => {
  test("Space toggles both", async ({ page }) => {
    const box = page.getByRole("checkbox", { name: "Remember this answer" });
    await box.focus();
    await page.keyboard.press(" ");
    await expect(box).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("checkbox-value")).toHaveText("remember: true");
    await page.keyboard.press(" ");
    await expect(page.getByTestId("checkbox-value")).toHaveText("remember: false");

    const sw = page.getByRole("switch", { name: "Enabled", exact: true });
    await sw.focus();
    await page.keyboard.press(" ");
    await expect(sw).toHaveAttribute("aria-checked", "false");
    await expect(page.getByTestId("switch-value")).toHaveText("enabled: false");
  });

  test("clicking the label toggles; disabled ones do not change", async ({ page }) => {
    await page.getByText("Remember this answer").click();
    await expect(page.getByTestId("checkbox-value")).toHaveText("remember: true");
    const disabled = page.getByRole("checkbox", { name: "Disabled" });
    await expect(disabled).toBeDisabled();
  });
});

test.describe("NumberInput", () => {
  test("formats thousands while typing and keeps the caret on the same digit", async ({ page }) => {
    const input = page.getByRole("textbox", { name: "Salary floor" });
    await expect(input).toHaveValue("30,000,000");
    await expect(input).toHaveAttribute("inputmode", "numeric");

    await input.fill("");
    await input.pressSequentially("45000000");
    await expect(input).toHaveValue("45,000,000");
    await expect(page.getByTestId("salary-value")).toHaveText("value: 45000000");

    await input.press("End");
    await input.press("Backspace");
    await expect(input).toHaveValue("4,500,000");

    // Insert at the start (Home doesn't move the caret on macOS, so set it).
    await input.evaluate((el: HTMLInputElement) => el.setSelectionRange(0, 0));
    await input.press("1");
    await expect(input).toHaveValue("14,500,000");
    // Caret stays right after the typed digit.
    expect(await input.evaluate((el: HTMLInputElement) => el.selectionStart)).toBe(1);

    // Insert after "14," while the separators move: caret ends right after the new 9.
    await input.evaluate((el: HTMLInputElement) => el.setSelectionRange(3, 3));
    await input.press("9");
    await expect(input).toHaveValue("149,500,000");
    expect(await input.evaluate((el: HTMLInputElement) => el.selectionStart)).toBe(3);

    await input.pressSequentially("ab");
    await expect(input).toHaveValue("149,500,000");
  });
});

test.describe("DropdownMenu", () => {
  test("renders outside the clipping table and its items are clickable", async ({ page }) => {
    const container = page.getByTestId("clipping-container");
    await page.getByTestId("row-menu-trigger").click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    const [box, menuBox] = await Promise.all([container.boundingBox(), menu.boundingBox()]);
    expect(menuBox!.y + menuBox!.height).toBeGreaterThan(box!.y + box!.height);
    // The last item is really on top (not clipped or covered).
    const del = menu.getByRole("menuitem", { name: "Delete" });
    const hit = await del.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return !!top && el.contains(top);
    });
    expect(hit).toBe(true);

    await menu.getByRole("menuitem", { name: "Run now" }).click();
    await expect(menu).toBeHidden();
    await expect(page.getByTestId("toast").filter({ hasText: "Run now: YAVIET" })).toBeVisible();
  });

  test("keyboard: Enter opens, arrows move, Esc closes", async ({ page }) => {
    await page.getByTestId("row-menu-trigger").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toBeHidden();
    await expect(page.getByTestId("row-menu-trigger")).toBeFocused();
  });
});

test.describe("ConfirmDialog + Undo toast", () => {
  test("delete asks first, then Undo restores the row in place", async ({ page }) => {
    const rows = page.getByTestId("schedule-row");
    await expect(rows).toHaveCount(2);

    await page.getByRole("button", { name: "Delete Weekday morning scan" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete “Weekday morning scan”?" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("You can undo for a few seconds.");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(rows).toHaveCount(2);

    await page.getByRole("button", { name: "Delete Weekday morning scan" }).click();
    await page.getByRole("button", { name: "Delete schedule" }).click();
    await expect(rows).toHaveCount(1);
    const toast = page.getByTestId("toast").filter({ hasText: "Deleted “Weekday morning scan”" });
    await expect(toast).toBeVisible();

    await toast.getByRole("button", { name: "Undo" }).click();
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("Weekday morning scan");
    await expect(page.getByTestId("toast").filter({ hasText: "Restored “Weekday morning scan”" })).toBeVisible();
  });

  test("Esc dismisses the confirm dialog", async ({ page }) => {
    await page.getByRole("button", { name: "Delete Weekend scan" }).click();
    await expect(page.getByTestId("confirm-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("confirm-dialog")).toBeHidden();
    await expect(page.getByTestId("schedule-row")).toHaveCount(2);
  });
});

test.describe("Dialog", () => {
  test("Esc on an open Select inside a dialog closes only the Select", async ({ page }) => {
    await page.getByRole("button", { name: "Open dialog" }).click();
    const dialog = page.getByRole("dialog", { name: "New schedule" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("combobox").click();
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox")).toBeHidden();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
});

test.describe("FileViewer", () => {
  test("clicking a PDF opens the viewer (no download); Download lives inside", async ({ page }) => {
    let downloads = 0;
    page.on("download", () => downloads++);

    await page.getByRole("button", { name: /NovaPay_FE_EN_v2\.pdf/ }).click();
    const viewer = page.getByTestId("file-viewer");
    await expect(viewer).toBeVisible();
    await expect(viewer.getByRole("heading", { name: "NovaPay_FE_EN_v2.pdf" })).toBeVisible();
    expect(downloads).toBe(0);

    // PDF.js renders both pages and the header shows the page count.
    await expect(viewer.locator("[data-testid=pdf-page][data-rendered]")).toHaveCount(2, { timeout: 15_000 });
    await expect(page.getByTestId("file-viewer-subtitle")).toHaveText("· page 1 of 2");

    // Zoom
    const firstPage = viewer.locator("[data-testid=pdf-page]").first();
    const before = (await firstPage.boundingBox())!.width;
    await viewer.getByRole("button", { name: "Zoom in" }).click();
    await expect(page.getByTestId("file-viewer-zoom")).toHaveText("125%");
    await expect.poll(async () => (await firstPage.boundingBox())!.width).toBeGreaterThan(before * 1.2);

    // Scrolling to the second page updates the page indicator.
    await page.getByTestId("file-viewer-body").evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect(page.getByTestId("file-viewer-subtitle")).toHaveText("· page 2 of 2");

    await expect(viewer.getByRole("link", { name: /Open in Figma/ })).toHaveAttribute("href", "https://www.figma.com/");

    const [download] = await Promise.all([page.waitForEvent("download"), viewer.getByRole("link", { name: "Download" }).click()]);
    expect(download.suggestedFilename()).toBe("NovaPay_FE_EN_v2.pdf");

    await page.keyboard.press("Escape");
    await expect(viewer).toBeHidden();
  });

  test("image, text, form preview and unsupported files", async ({ page }) => {
    const viewer = page.getByTestId("file-viewer");

    await page.getByRole("button", { name: /confirmation\.png/ }).click();
    await expect(viewer.getByRole("img", { name: "confirmation.png" })).toBeVisible();
    await expect(page.getByTestId("file-viewer-subtitle")).toHaveText("· confirmation screenshot");
    await viewer.getByRole("button", { name: "Close" }).click();
    await expect(viewer).toBeHidden();

    await page.getByRole("button", { name: /jd_snapshot\.txt/ }).click();
    await expect(page.getByTestId("file-viewer-text")).toContainText("Senior Frontend Engineer (React/Next.js) - NovaPay");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: /pre_submit\.png/ }).click();
    await expect(page.getByTestId("file-viewer-form")).toContainText("Preferred location");
    await expect(page.getByTestId("file-viewer-form")).toContainText("Employer personal-data-use agreement (TopCV)");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: /notes\.docx/ }).click();
    await expect(viewer).toContainText("No preview for this file type.");
    await expect(viewer.getByRole("button", { name: "Download" })).toBeDisabled();
  });
});

test.describe("FileDropzone", () => {
  test("accepts valid files, rejects others, and opens accepted files in the viewer", async ({ page }) => {
    const input = page.getByTestId("file-dropzone-input").first();
    await input.setInputFiles([
      { name: "cover.txt", mimeType: "text/plain", buffer: Buffer.from("Hello from a dropped file") },
      { name: "virus.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") },
    ]);
    await expect(page.getByRole("alert").filter({ hasText: "virus.exe: only PDF, DOC, DOCX, TXT, PNG or JPG files are accepted." })).toBeVisible();
    await page.getByTestId("uploaded-list").getByRole("button", { name: /cover\.txt/ }).click();
    await expect(page.getByTestId("file-viewer-text")).toHaveText("Hello from a dropped file");
  });

  test("rejects files over 10 MB", async ({ page }) => {
    await page.getByTestId("file-dropzone-input").first().setInputFiles({
      name: "huge.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
    });
    await expect(page.getByRole("alert").filter({ hasText: "the limit is 10 MB" })).toBeVisible();
  });
});

test.describe("Cursor rule", () => {
  const CLICKABLE = [
    "button",
    "a[href]",
    "[role=button]",
    "[role=tab]",
    "[role=switch]",
    "[role=checkbox]",
    "[role=combobox]",
    "[role=slider]",
    "[role=option]",
    "[role=menuitem]",
    "[data-clickable]",
  ].join(",");

  async function offenders(page: Page) {
    return page.evaluate((selector) => {
      const bad: string[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (r.width === 0 || r.height === 0 || style.visibility === "hidden" || style.display === "none") continue;
        const disabled =
          (el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true" || el.hasAttribute("data-disabled");
        const expected = disabled ? "not-allowed" : "pointer";
        if (style.cursor !== expected) {
          bad.push(`${el.tagName.toLowerCase()}[${el.getAttribute("role") ?? ""}] "${(el.textContent ?? el.getAttribute("aria-label") ?? "").trim().slice(0, 30)}" → ${style.cursor} (want ${expected})`);
        }
      }
      return bad;
    }, CLICKABLE);
  }

  test("every clickable element in the gallery uses cursor: pointer (disabled: not-allowed)", async ({ page }) => {
    const count = await page.locator(CLICKABLE).count();
    expect(count).toBeGreaterThan(60);
    expect(await offenders(page)).toEqual([]);

    // Floating layers too: Select options and menu items.
    await page.getByTestId("select-repeat").click();
    expect(await offenders(page)).toEqual([]);
    await page.keyboard.press("Escape");
    await page.getByTestId("row-menu-trigger").click();
    expect(await offenders(page)).toEqual([]);
  });

  test("the app shell follows the rule as well", async ({ page }) => {
    await open(page, "/chat");
    expect(await offenders(page)).toEqual([]);
  });

  test("no browser-default select, range, checkbox, number or visible file inputs", async ({ page }) => {
    const natives = await page.evaluate(() =>
      Array.from(document.querySelectorAll("select, input[type=range], input[type=checkbox], input[type=radio], input[type=number], input[type=date], input[type=time], input[type=file]"))
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 1 && r.height > 1 && getComputedStyle(el).visibility !== "hidden";
        })
        .map((el) => el.outerHTML.slice(0, 80)),
    );
    expect(natives).toEqual([]);
  });
});
