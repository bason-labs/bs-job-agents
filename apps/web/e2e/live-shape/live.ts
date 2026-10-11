import { inflateRawSync } from "node:zlib";
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

/** The entries of a ZIP file (stored or deflated), read from its central directory. */
export function unzip(zip: Buffer): Map<string, Buffer> {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("not a ZIP file");
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28);
    const extraLen = zip.readUInt16LE(at + 30);
    const commentLen = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(dataAt, dataAt + size);
    out.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
