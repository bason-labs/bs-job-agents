import type { PageAssertionsToHaveScreenshotOptions } from "@playwright/test";

/** The clock every screenshot comparison runs at (Date only; timers keep running). */
export const FROZEN_NOW = new Date("2026-10-11T09:30:00+07:00");

/**
 * Sane thresholds: anti-aliasing and sub-pixel font differences pass (per-pixel colour distance
 * 0.2, at most 1% of the pixels); a changed colour, a moved block or a missing element does not.
 */
export const SCREENSHOT_OPTIONS: PageAssertionsToHaveScreenshotOptions = {
  animations: "disabled",
  caret: "hide",
  scale: "css",
  threshold: 0.2,
  maxDiffPixelRatio: 0.01,
};
