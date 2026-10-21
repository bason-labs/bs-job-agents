// API research (design §5.1): Ba's approval of a high-risk board, bound to the record's researchedAt.
import { beforeEach, describe, expect, it } from "vitest";
import { openTestDb, type Db } from "../client.js";
import { T0, at } from "../test-helpers.js";
import { approveSource, getSourceApproval, isSourceApproved, revokeSource } from "./source-approvals.js";

let db: Db;
beforeEach(() => {
  db = openTestDb();
});

describe("source approvals", () => {
  it("approve, read and revoke", () => {
    expect(getSourceApproval(db, "linkedin")).toBeUndefined();
    const a = approveSource(db, { source: "linkedin", researchedAt: "2026-10-19" }, { now: T0 });
    expect(a).toEqual({ source: "linkedin", approvedAt: T0.toISOString(), researchedAt: "2026-10-19" });
    expect(isSourceApproved(db, "linkedin", "2026-10-19")).toBe(true);
    expect(revokeSource(db, "linkedin")).toBe(true);
    expect(isSourceApproved(db, "linkedin", "2026-10-19")).toBe(false);
    expect(revokeSource(db, "linkedin")).toBe(false);
  });

  it("lapses when the record is re-researched; approving again replaces it", () => {
    approveSource(db, { source: "upwork", researchedAt: "2026-10-19" }, { now: T0 });
    expect(isSourceApproved(db, "upwork", "2026-11-02")).toBe(false);
    approveSource(db, { source: "upwork", researchedAt: "2026-11-02" }, { now: at(60) });
    expect(getSourceApproval(db, "upwork")).toEqual({ source: "upwork", approvedAt: at(60).toISOString(), researchedAt: "2026-11-02" });
  });
});
