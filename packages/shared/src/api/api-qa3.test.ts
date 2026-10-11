// Phase 3 QA additions to the shared API (additive): review flags for F3's S15/S16 and the
// "Don't allow" route (UC-11 e).
import { describe, expect, it } from "vitest";
import { API_ROUTES } from "./common.js";
import { ReviewCardFlagsSchema } from "./review.js";

const base = { qaPassed: true, escalated: false, needsInput: false, injectionFlagged: false, masterChanged: false, noApplyLink: false, lowConfidenceCompany: false };

describe("review card flags (PM2 S15, S16)", () => {
  it("carry companyMissing and dryRunSettled, and keep them when parsed", () => {
    const parsed = ReviewCardFlagsSchema.parse({ ...base, companyMissing: true, dryRunSettled: true });
    expect(parsed).toMatchObject({ companyMissing: true, dryRunSettled: true });
  });

  it("stay optional for older payloads and refuse non-booleans", () => {
    expect(ReviewCardFlagsSchema.safeParse(base).success).toBe(true);
    expect(ReviewCardFlagsSchema.safeParse({ ...base, dryRunSettled: "yes" }).success).toBe(false);
  });
});

describe("API_ROUTES (Phase 3 QA)", () => {
  it("has the UC-11 e decline-domain route", () => {
    expect(API_ROUTES.taskDeclineDomain).toBe("/tasks/:id/decline-domain");
  });
});
