import { expect, test, type Page } from "@playwright/test";
import { open, simulate, withMock } from "./helpers";

// Chat (spec §11) on the mock orchestrator: UC-01, UC-25, UC-12, UC-17, UC-11 e, UC-16, UC-24, UC-21b a.

const composer = (page: Page) => page.getByRole("textbox", { name: /^Message / });
const lead = (page: Page) => page.locator('[data-testid=message][data-author=lead]');

async function say(page: Page, text: string) {
  await composer(page).fill(text);
  await composer(page).press("Enter");
}

test("UC-01: a find request starts a job scan; the run card traces the delegation live", async ({ page }) => {
  await open(page, "/chat");
  await expect(page.getByRole("navigation", { name: "Bots" }).getByRole("link", { name: "Lead" })).toHaveAttribute("aria-current", "page");
  // The seeded conversation: run #12's card and the review link.
  await expect(page.locator('[data-testid=run-card][data-run="12"]')).toContainText("Job scan #12");
  await expect(page.getByTestId("review-link")).toHaveAttribute("href", "/review");

  await say(page, "Find frontend jobs in HCM, React/Next.js, salary ≥ 25M");
  await expect(page.locator('[data-testid=message][data-author=ba]').last()).toContainText("Find frontend jobs in HCM");
  await expect(composer(page)).toHaveValue("");
  await expect(lead(page).filter({ hasText: "Started Job scan #13" })).toBeVisible();
  const card = page.locator('[data-testid=run-card][data-run="13"]');
  await expect(card.getByTestId("trace-scan")).toContainText("Lead →@Research");
  // While Research scans, the sidebar shows it working.
  await expect(page.getByTestId("sidebar").getByText("working")).toBeVisible();
  await expect(card.getByTestId("trace-qa")).toHaveAttribute("data-status", "done", { timeout: 30_000 });
  await expect(lead(page).filter({ hasText: "2 jobs ready for review" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("sidebar").getByRole("link", { name: /^Review/ })).toContainText("5");
  await card.getByRole("link", { name: /Open flow/ }).click();
  await expect(page).toHaveURL(/\/flows\/13$/);
});

/** The run card's last row is inside the chat's scroll area (not below the fold). */
const cardBottomInView = (page: Page, runId: string) =>
  page.evaluate((id) => {
    const scroller = document.querySelector('[data-testid="chat-scroll"]')!.getBoundingClientRect();
    const card = document.querySelector(`[data-testid=run-card][data-run="${id}"]`)!.getBoundingClientRect();
    return card.bottom <= scroller.bottom + 1;
  }, runId);

test("PM3 S5/S7: Lead's turn shows a working indicator with its tool step; the chat keeps following the run card as it grows", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  await open(page, "/chat");
  await say(page, "Find frontend jobs in HCM");
  // S5: "Lead is working" while the lead.chat task runs, with its tool call as a step; gone when it ends.
  await expect(page.getByTestId("typing")).toContainText("Lead is working");
  await expect(page.getByTestId("working-steps")).toContainText("Starting job-scan…");
  await expect(lead(page).filter({ hasText: "Started Job scan #13" })).toBeVisible();
  await expect(page.getByTestId("typing")).toBeHidden();
  // S7: the card grows row by row (Research, CV, QA) with no new message; the view follows it.
  const card = page.locator('[data-testid=run-card][data-run="13"]');
  await expect(card.getByTestId("trace-cv")).toBeAttached({ timeout: 30_000 });
  await expect.poll(() => cardBottomInView(page, "13")).toBe(true);
  await expect(card.getByTestId("trace-qa")).toBeAttached({ timeout: 30_000 });
  await expect.poll(() => cardBottomInView(page, "13")).toBe(true);
});

test("PM3 S7: the chat follows content that grows without a new message (a run card's rows), unless Ba scrolled up", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  await open(page, "/chat");
  const atBottom = () =>
    page.getByTestId("chat-scroll").evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 2);
  await expect.poll(atBottom).toBe(true);
  // A card grows in place (as a run card does when its trace fills in): the view keeps up.
  const grow = () =>
    page.locator('[data-testid=run-card][data-run="12"]').evaluate((el) => {
      const row = document.createElement("div");
      row.style.height = "300px";
      el.appendChild(row);
    });
  await grow();
  await expect.poll(atBottom).toBe(true);
  // Ba scrolls up to read: growth no longer pulls the view down.
  await page.getByTestId("chat-scroll").evaluate((el) => el.scrollTo({ top: 0 }));
  await grow();
  await expect.poll(() => page.getByTestId("chat-scroll").evaluate((el) => el.scrollTop)).toBe(0);
});

test("UC-25: a work request in a consult chat is handed to Lead, who starts it", async ({ page }) => {
  await open(page, "/chat/research");
  await expect(page.getByTestId("consult-banner")).toContainText("Direct chat with Research · consult mode");
  await expect(page.getByTestId("greeting")).toContainText("Research here (consult mode)");
  await page.getByRole("button", { name: "Ask for work (→ handed to Lead)" }).click();
  await expect(composer(page)).toHaveValue("Find more AI jobs for me");
  await composer(page).press("Enter");
  const reply = page.locator('[data-testid=message][data-author=research]').last();
  await expect(reply).toContainText("passed it to Lead");
  await expect(reply).toContainText("consult");
  await reply.getByRole("link", { name: "Open Lead chat" }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(lead(page).filter({ hasText: "Handed over from @Research" })).toBeVisible();
  await expect(page.locator('[data-testid=run-card][data-run="13"]')).toBeVisible();
});

test("UC-25: a question in a consult chat gets an answer, not a hand-off", async ({ page }) => {
  await open(page, "/chat/qa");
  await page.getByRole("button", { name: "Ask a question" }).click();
  const reply = page.locator('[data-testid=message][data-author=qa]').last();
  await expect(reply).toContainText("I score JD match 40");
  await expect(reply.getByRole("link", { name: "Open Lead chat" })).toHaveCount(0);
  await expect(page.getByTestId("engine-chip")).toHaveText("QA · Codex");
});

test.describe("UC-12: Apply's questions, one at a time", () => {
  async function approveSaoViet(page: Page) {
    await open(page, "/chat");
    await withMock(page, (m) => m.approve("102", { cvVersionId: "2202", introText: null }));
  }

  test("optional salary: Negotiable / Thỏa thuận; then a required field with no Skip", async ({ page }) => {
    await approveSaoViet(page);
    const salary = page.locator('[data-testid=question-card][data-field=salary]');
    await expect(salary).toHaveAttribute("data-state", "live");
    await expect(salary).toContainText("Optional field — you can skip it");
    await expect(salary).toContainText("Mức lương mong muốn (VND)");
    await expect(salary.getByRole("checkbox", { name: "Remember this answer for future forms" })).toBeChecked();
    await salary.getByRole("button", { name: "Negotiable / Thỏa thuận" }).click();
    await expect(salary).toHaveAttribute("data-state", "answered");
    await expect(salary).toContainText("Saved as a remembered answer for future forms.");

    const start = page.locator('[data-testid=question-card][data-field=start_date]');
    await expect(start).toContainText("Required field");
    await expect(start.getByRole("button", { name: "Skip — leave blank" })).toHaveCount(0);
    await expect(start.getByRole("button", { name: "Negotiable / Thỏa thuận" })).toHaveCount(0);
    await start.getByRole("textbox").fill("2 weeks after offer");
    await start.getByRole("button", { name: "Send" }).click();
    await expect(start).toContainText("2 weeks after offer");
    await expect(lead(page).filter({ hasText: "Sao Việt Tech submitted" })).toBeVisible({ timeout: 20_000 });
  });

  test("optional salary can be skipped (left blank)", async ({ page }) => {
    await approveSaoViet(page);
    const salary = page.locator('[data-testid=question-card][data-field=salary]');
    await salary.getByRole("button", { name: "Skip — leave blank" }).click();
    await expect(salary).toContainText("Left blank — optional");
    await expect(page.locator('[data-testid=question-card][data-field=start_date]')).toHaveAttribute("data-state", "live");
  });
});

test("UC-17: a login pause asks Ba to fix it in Chrome, then Done resumes the task", async ({ page }) => {
  await open(page, "/chat");
  await simulate(page, /LinkedIn login expired/);
  const card = page.getByTestId("pause-card").last();
  await expect(card).toContainText("Log in to linkedin.com");
  await expect(card.getByTestId("pause-host")).toHaveText("linkedin.com");
  await expect(card).toContainText("Research's tab group");
  await card.getByRole("button", { name: "Done — I'm logged in" }).click();
  await expect(card).toHaveAttribute("data-state", "resumed");
  await expect(card).toContainText("Resumed — Research picks up where it stopped.");
});

test("UC-11 e: Apply asks before using another site (PM S24 wording)", async ({ page }) => {
  await open(page, "/chat");
  await simulate(page, /Apply leaves the job site/);
  const card = page.getByTestId("pause-card").last();
  await expect(card.getByTestId("pause-host")).toHaveText("acme.wd3.myworkdayjobs.com");
  await expect(card).toContainText(
    "Apply tried to open acme.wd3.myworkdayjobs.com, which is not the employer's job site. Allow it for this application?",
  );
  await card.getByRole("button", { name: "Allow acme.wd3.myworkdayjobs.com" }).click();
  await expect(card).toHaveAttribute("data-state", "resumed");
});

test("UC-16: a usage limit shows the clock time and a human countdown (PM S8), and clears on reset", async ({ page }) => {
  await open(page, "/chat");
  await simulate(page, /Claude usage limit hit/);
  const banner = page.getByTestId("paused-banner");
  await expect(banner).toHaveText(/Claude paused until \d\d:\d\d · resumes in 2h 1\dm/);
  await expect(banner).not.toContainText(/\d{4,}s/);
  await expect(page.getByTestId("usage-claude")).toContainText(/paused · resumes in 2h 1\dm/);
  await expect(lead(page).filter({ hasText: "Claude usage limit reached" })).toBeVisible();
  await simulate(page, /Usage limits reset/);
  await expect(banner).toHaveCount(0);
});

test("Resume now on the paused banner lifts a usage-limit pause early (live run 1)", async ({ page }) => {
  await open(page, "/chat");
  await simulate(page, /Claude usage limit hit/);
  const banner = page.getByTestId("paused-banner");
  await expect(banner).toContainText("Claude paused until");
  await banner.getByRole("button", { name: "Resume Claude now" }).click();
  await expect(banner).toHaveCount(0);
  await expect(lead(page).filter({ hasText: "Claude resumed by you" })).toBeVisible();
});

test("UC-24: attach files (chip → viewer, × removes, wrong type refused) and send a JD", async ({ page }) => {
  await open(page, "/chat");
  const input = page.getByTestId("file-dropzone-input");
  await input.setInputFiles([
    { name: "JD_Acme.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF") },
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") },
  ]);
  await expect(page.getByTestId("attachment-chip")).toHaveCount(2);
  await page.getByRole("button", { name: "notes.txt", exact: true }).click();
  await expect(page.getByTestId("file-viewer")).toBeVisible();
  await expect(page.getByTestId("file-viewer-text")).toHaveText("hello");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Remove notes.txt" }).click();
  await expect(page.getByTestId("attachment-chip")).toHaveCount(1);

  await input.setInputFiles({ name: "setup.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") });
  await expect(page.getByRole("alert").filter({ hasText: "setup.exe" })).toBeVisible();
  await expect(page.getByTestId("attachment-chip")).toHaveCount(1);

  await page.getByTestId("send").click();
  await expect(page.locator('[data-testid=message][data-author=ba]').last().getByRole("button", { name: /JD_Acme\.pdf/ })).toBeVisible();
  await expect(lead(page).filter({ hasText: "Got JD_Acme.pdf" })).toBeVisible();
  await expect(page.locator('[data-testid=run-card]').last()).toContainText("Apply to file");
});

// A real 2×2 PNG, so the thumbnail and the viewer actually decode it.
const PNG_2X2 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP4z8DAwPAfhP7/ZwAAHu8E/Gj7YDYAAAAASUVORK5CYII=";

/** Cmd+V of a screenshot: a paste event whose clipboard holds one image file named "image.png". */
async function pasteImage(page: Page) {
  await composer(page).evaluate((el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "image.png", { type: "image/png" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, PNG_2X2);
}

const decoded = (img: ReturnType<Page["locator"]>) => img.evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0);

test("F8: a pasted screenshot becomes a chip with a preview, is sent, and opens as an image (not 'No preview')", async ({ page }) => {
  await open(page, "/chat");
  await pasteImage(page);
  const chip = page.getByTestId("attachment-chip");
  await expect(chip).toHaveCount(1);
  await expect(chip).toContainText(/pasted-image-\d{8}-\d{6}\.png/);
  await expect.poll(() => decoded(chip.getByTestId("attachment-thumbnail"))).toBe(true);
  // × removes it; paste again and send it with a question.
  await chip.getByRole("button", { name: /^Remove pasted-image-/ }).click();
  await expect(chip).toHaveCount(0);
  await pasteImage(page);
  await composer(page).fill("What's wrong in this screenshot?");
  await composer(page).press("Enter");

  const sent = page.locator("[data-testid=message][data-author=ba]").last().getByTestId("message-attachment");
  await expect(sent).toHaveAttribute("data-kind", "image");
  await expect(sent).toContainText(/pasted-image-\d{8}-\d{6}\.png/);
  await expect.poll(() => decoded(sent.getByTestId("attachment-thumbnail"))).toBe(true);
  await sent.click();
  const viewer = page.getByTestId("file-viewer");
  await expect(viewer.getByRole("img", { name: /pasted-image-/ })).toBeVisible();
  await expect.poll(() => decoded(viewer.getByRole("img", { name: /pasted-image-/ }))).toBe(true);
  await expect(viewer).not.toContainText("No preview for this file type.");
  await expect(viewer.getByRole("link", { name: "Download" })).toBeVisible();
  await page.keyboard.press("Escape");
  // Lead looked at it (the mock mirrors the orchestrator's scoped Read of the image).
  await expect(lead(page).filter({ hasText: /I looked at pasted-image-/ })).toBeVisible();
});

test("F8: an uploaded PNG picked with Attach file opens as an image in the viewer", async ({ page }) => {
  await open(page, "/chat");
  await page.getByTestId("file-dropzone-input").setInputFiles({ name: "Screenshot at Oct 11 5-14-30 PM.png", mimeType: "image/png", buffer: Buffer.from(PNG_2X2, "base64") });
  await expect(page.getByTestId("attachment-chip").getByTestId("attachment-thumbnail")).toBeVisible();
  await page.getByTestId("send").click();
  const sent = page.locator("[data-testid=message][data-author=ba]").last().getByTestId("message-attachment");
  await expect(sent).toContainText("Screenshot at Oct 11 5-14-30 PM.png");
  await sent.click();
  await expect(page.getByTestId("file-viewer").getByRole("img", { name: "Screenshot at Oct 11 5-14-30 PM.png" })).toBeVisible();
});

test("UC-21b a: 'also include Đà Nẵng' asks just this run or save, and the choice sticks", async ({ page }) => {
  await open(page, "/chat");
  await page.getByRole("button", { name: "Also include Đà Nẵng" }).click();
  await composer(page).press("Enter");
  const choice = page.getByTestId("choice-card").last();
  await expect(choice.getByRole("button", { name: "Just this run" })).toBeVisible();
  await choice.getByRole("button", { name: "Save to my criteria" }).click();
  await expect(choice).toContainText("You chose “Save to my criteria”.");
  await expect(lead(page).filter({ hasText: "Saved to your search criteria (now v4)." })).toBeVisible();
  await expect(lead(page).filter({ hasText: "Save to your search criteria (now v3)? Add Đà Nẵng to locations." })).toBeVisible();
});

test("UC-21 via Lead (PM3 S1): 'scan every weekday at 9' proposes a schedule; one click creates it", async ({ page }) => {
  await open(page, "/chat");
  await composer(page).fill("Scan every weekday at 9");
  await composer(page).press("Enter");
  const proposal = lead(page).filter({ hasText: "Create the schedule “Weekday morning scan”? Runs: Weekdays 09:00" });
  await expect(proposal).toBeVisible();
  await proposal.getByRole("button", { name: "Create schedule" }).click();
  await expect(proposal.getByTestId("choice-card")).toContainText("You chose “Create schedule”.");
  await expect(lead(page).filter({ hasText: "Created the schedule “Weekday morning scan” (Weekdays 09:00)." })).toBeVisible();
});
