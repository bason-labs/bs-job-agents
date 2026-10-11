import { describe, expect, it } from "vitest";
import { uniqueFactRequests } from "./review.js";

describe("review card fact requests", () => {
  it("lists a topic once when the VI and EN versions both ask it (live run 1)", () => {
    const vi = { topic: "Web performance optimisation", question: "Q (VI version)", reason: "R" };
    const en = { topic: "web performance optimisation ", question: "Q (EN version)", reason: "R" };
    const other = { topic: "Cross-browser compatibility", question: "Q2", reason: "R2" };
    expect(uniqueFactRequests([vi, other, en])).toEqual([vi, other]);
  });
});
