import { describe, expect, it } from "vitest";
import { moveIndex, typeaheadIndex } from "./listNav";

const items = [
  { label: "Weekdays" },
  { label: "Daily" },
  { label: "Weekly", disabled: true },
  { label: "Custom" },
];

describe("moveIndex", () => {
  it("moves down and wraps, skipping disabled items", () => {
    expect(moveIndex(items, 0, 1)).toBe(1);
    expect(moveIndex(items, 1, 1)).toBe(3);
    expect(moveIndex(items, 3, 1)).toBe(0);
  });

  it("moves up and wraps", () => {
    expect(moveIndex(items, 0, -1)).toBe(3);
    expect(moveIndex(items, 3, -1)).toBe(1);
  });

  it("returns -1 for an empty or fully disabled list", () => {
    expect(moveIndex([], 0, 1)).toBe(-1);
    expect(moveIndex([{ label: "x", disabled: true }], 0, 1)).toBe(-1);
  });
});

describe("typeaheadIndex", () => {
  it("finds the next item whose label starts with the query, after the current one", () => {
    expect(typeaheadIndex(items, "c", 0)).toBe(3);
    expect(typeaheadIndex(items, "w", 0)).toBe(0);
    expect(typeaheadIndex(items, "d", 3)).toBe(1);
  });

  it("is case-insensitive and supports multi-character queries", () => {
    expect(typeaheadIndex(items, "DAI", 0)).toBe(1);
  });

  it("cycles through items when the same letter is repeated", () => {
    const xs = [{ label: "Mon" }, { label: "Tue" }, { label: "Thu" }];
    expect(typeaheadIndex(xs, "t", 1)).toBe(2);
    expect(typeaheadIndex(xs, "tt", 2)).toBe(1);
  });

  it("returns -1 when nothing matches", () => {
    expect(typeaheadIndex(items, "z", 0)).toBe(-1);
  });
});
