import { expect, test, type Page } from "@playwright/test";
import { open } from "./helpers";

// Review queue (spec §11) on the mock orchestrator: UC-07 a/b, UC-08 (+ a, b), UC-09, UC-10.

const card = (page: Page, company: string) => page.getByRole("article", { name: new RegExp(`— ${company}$`) });
const reviewBadge = (page: Page) => page.getByTestId("sidebar").getByRole("link", { name: /^Review/ });

test("UC-08: approve & submit — the dialog says what Apply will do; the card follows Apply until submitted", async ({ page }) => {
  await open(page, "/review");
  const nova = card(page, "NovaPay");
  await expect(nova.getByTestId("fit")).toHaveText("87");
  await expect(nova.getByTestId("qa-box")).toContainText("88 · passed");
  await expect(nova.getByTestId("qa-rounds")).toContainText("R1 72 ✗");
  // UC-08 b: an edited intro is used as written.
  await nova.getByLabel("Intro / cover text (optional)").fill("I'd love to bring my React ownership to NovaPay.");
  await nova.getByRole("button", { name: "Approve & submit" }).click();
  const dialog = page.getByTestId("approve-dialog");
  await expect(dialog.getByRole("heading", { name: "Approve & submit to NovaPay?" })).toBeVisible();
  await expect(dialog).toContainText("on itviec.com only");
  await expect(dialog).toContainText("Uploads NOVAPAY_FRONTEND_EN_v2.pdf");
  await expect(dialog).toContainText("tick the employer's personal-data consent box");
  await expect(dialog).toContainText("Your intro text is used as written.");
  await dialog.getByRole("button", { name: "Approve & submit" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("toast").filter({ hasText: "Approval token created for NovaPay" })).toBeVisible();
  await expect(nova.getByTestId("acted")).toContainText("Apply is working in your Chrome… see chat");
  await expect(reviewBadge(page)).toContainText("2");
  await expect(page.getByTestId("toast").filter({ hasText: "NovaPay submitted" })).toBeVisible({ timeout: 20_000 });
  await expect(nova).toHaveCount(0);
});

test("UC-08 a: a Vietnamese JD offers the VI and EN CVs (VI by default)", async ({ page }) => {
  await open(page, "/review");
  const sao = card(page, "Sao Việt Tech");
  const vi = sao.getByRole("radio", { name: "CV tiếng Việt" });
  await expect(vi).toHaveAttribute("aria-checked", "true");
  await expect(sao.getByRole("button", { name: /SAOVIETTECH_FRONTEND_VI_v2\.pdf/ })).toBeVisible();
  await expect(sao.getByTestId("qa-box")).toContainText("84 · passed");
  await sao.getByRole("radio", { name: "CV English" }).click();
  await expect(sao.getByRole("button", { name: /SAOVIETTECH_FRONTEND_EN_v1\.pdf/ })).toBeVisible();
  await expect(sao.getByTestId("qa-box")).toContainText("85 · passed");
  await sao.getByRole("button", { name: "Approve & submit" }).click();
  await expect(page.getByTestId("approve-dialog")).toContainText("Uploads SAOVIETTECH_FRONTEND_EN_v1.pdf");
  await expect(page.getByTestId("approve-dialog")).toContainText("on topcv.vn only");
});

test("the CV opens in the in-app viewer first; Download and Open in Figma are inside it", async ({ page }) => {
  await open(page, "/review");
  await card(page, "NovaPay").getByTestId("cv-preview").click();
  const viewer = page.getByTestId("file-viewer");
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole("heading", { name: "NOVAPAY_FRONTEND_EN_v2.pdf" })).toBeVisible();
  await expect(viewer.getByRole("link", { name: /Download/ })).toHaveAttribute("download", "NOVAPAY_FRONTEND_EN_v2.pdf");
  await expect(viewer.getByRole("link", { name: /Open in Figma/ })).toHaveAttribute("href", /figma\.com/);
  await expect(page.getByTestId("file-viewer-subtitle")).toContainText(/page 1 of \d+/);
  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();
});

test("UC-09: request changes sends a note to CV; the card comes back after a new QA round", async ({ page }) => {
  await open(page, "/review");
  const nova = card(page, "NovaPay");
  await nova.getByRole("button", { name: "Request changes…" }).click();
  const dialog = page.getByTestId("changes-dialog");
  await expect(dialog.getByRole("heading", { name: "Request changes — NovaPay" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Send to CV" })).toBeDisabled();
  await dialog.getByLabel("What should change?").fill("Lead with Next.js; drop the education portal project");
  await dialog.getByRole("button", { name: "Send to CV" }).click();
  await expect(nova.getByTestId("acted")).toHaveText("● CV is revising with your note → QA will re-score…");
  await expect(nova.getByTestId("qa-rounds")).toContainText("R3 92 ✓", { timeout: 20_000 });
  await expect(nova.getByTestId("qa-box")).toContainText("round 3 of 3");
  await expect(nova.getByRole("button", { name: "Approve & submit" })).toBeVisible();
});

test("UC-10: skip needs a reason (Other needs a note) and is listed under the queue", async ({ page }) => {
  await open(page, "/review");
  await card(page, "NovaPay").getByRole("button", { name: "Skip (give reason)" }).click();
  const dialog = page.getByTestId("skip-dialog");
  await expect(dialog.getByRole("heading", { name: "Skip NovaPay — why?" })).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "Salary too low" })).toHaveAttribute("aria-checked", "true");
  await dialog.getByRole("radio", { name: "Other" }).click();
  await expect(dialog.getByRole("button", { name: "Skip job" })).toBeDisabled();
  await dialog.getByLabel("Note").fill("Too far from home");
  await dialog.getByRole("button", { name: "Skip job" }).click();
  await expect(card(page, "NovaPay")).toHaveCount(0);
  await expect(page.getByTestId("skipped")).toHaveText("Skipped: NovaPay (other)");
  await expect(page.getByTestId("toast").filter({ hasText: "NovaPay skipped (other)" })).toBeVisible();
  await expect(reviewBadge(page)).toContainText("2");
});

test("UC-07 a/b: an escalated, flagged card explains itself; Apply stays off until Ba confirms the posting", async ({ page }) => {
  await open(page, "/review");
  const kite = card(page, "Kite Labs");
  await expect(kite.getByTestId("escalation")).toHaveText(
    "QA did not pass after 3 rounds: JD wants Python 3+ years; master data has none. Decide: approve anyway, request changes, or skip.",
  );
  await expect(kite.getByTestId("flag-lowConfidence")).toContainText("low confidence");
  await expect(kite.getByTestId("flag-injection")).toContainText("possible prompt injection");
  const approve = kite.getByRole("button", { name: "Approve anyway & submit" });
  await expect(approve).toBeDisabled();
  await kite.getByRole("button", { name: "I checked it — enable Apply" }).click();
  const confirm = page.getByTestId("confirm-dialog");
  await expect(confirm).toContainText("Is the Kite Labs posting safe?");
  await confirm.getByRole("button", { name: "It's safe — enable Apply" }).click();
  await expect(kite.getByTestId("flag-injectionCleared")).toBeVisible();
  await expect(approve).toBeEnabled();
});
