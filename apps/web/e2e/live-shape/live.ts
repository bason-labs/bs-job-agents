import { expect, type Page } from "@playwright/test";
import { open } from "../helpers";

// Helpers for the live-shape lane: the launcher's control server and the common chat steps.

const CONTROL = `http://127.0.0.1:${process.env.E2E_CONTROL_PORT ?? 4198}`;

/** A fresh orchestrator on a new, empty data folder (criteria and master CV seeded). */
export async function resetOrchestrator(): Promise<void> {
  const res = await fetch(`${CONTROL}/reset`, { method: "POST" });
  if (!res.ok) throw new Error(`reset failed: ${res.status} ${await res.text()}`);
}

export interface RunnerCall {
  key: string;
  taskId: number;
  attempt: number;
  input: Record<string, unknown>;
}

/** Every task the fake runners were given since the last reset. */
export async function runnerCalls(key?: string): Promise<RunnerCall[]> {
  const calls = (await (await fetch(`${CONTROL}/calls`)).json()) as RunnerCall[];
  return key ? calls.filter((c) => c.key === key) : calls;
}

export const composer = (page: Page) => page.getByRole("textbox", { name: /^Message / });
export const leadMessages = (page: Page) => page.locator("[data-testid=message][data-author=lead]");
export const reviewCard = (page: Page, company: string) => page.getByRole("article", { name: new RegExp(`— ${company}$`) });
export const reviewBadge = (page: Page) => page.getByTestId("sidebar").getByRole("link", { name: /^Review/ });

/** Opens the Lead chat and sends Ba's message. */
export async function sayToLead(page: Page, text: string): Promise<void> {
  if (!/\/chat$/.test(new URL(page.url()).pathname)) await open(page, "/chat");
  await composer(page).fill(text);
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-testid=message][data-author=ba]").last()).toContainText(text);
}

/** UC-01: asks Lead for a scan and waits until the run's three jobs wait in the review queue. */
export async function scanToReview(page: Page): Promise<string> {
  await sayToLead(page, "Please scan for frontend jobs in HCM");
  const card = page.getByTestId("run-card").first();
  await expect(card).toBeVisible();
  const runId = await card.getAttribute("data-run");
  await expect(reviewBadge(page)).toContainText("3", { timeout: 45_000 });
  return runId!;
}
