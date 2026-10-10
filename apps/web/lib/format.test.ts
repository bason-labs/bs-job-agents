import { describe, expect, it } from "vitest";
import { caretAfterDigits, digitsBefore, formatThousands, parseDigits } from "./format";

describe("formatThousands", () => {
  it("adds comma thousand separators", () => {
    expect(formatThousands(30000000)).toBe("30,000,000");
    expect(formatThousands(25000000)).toBe("25,000,000");
    expect(formatThousands(999)).toBe("999");
    expect(formatThousands(1000)).toBe("1,000");
    expect(formatThousands(0)).toBe("0");
  });

  it("renders null as an empty string", () => {
    expect(formatThousands(null)).toBe("");
  });
});

describe("parseDigits", () => {
  it("keeps only digits", () => {
    expect(parseDigits("30,000,000")).toBe(30000000);
    expect(parseDigits("1a2b3")).toBe(123);
    expect(parseDigits(" 2 500 ")).toBe(2500);
  });

  it("returns null when there are no digits", () => {
    expect(parseDigits("")).toBeNull();
    expect(parseDigits("abc")).toBeNull();
  });

  it("strips leading zeros", () => {
    expect(parseDigits("000123")).toBe(123);
    expect(parseDigits("0")).toBe(0);
  });
});

describe("caret helpers", () => {
  it("counts digits before a caret position", () => {
    expect(digitsBefore("30,000,000", 4)).toBe(3);
    expect(digitsBefore("30,000,000", 0)).toBe(0);
  });

  it("finds the caret position after N digits in formatted text", () => {
    expect(caretAfterDigits("30,000,000", 3)).toBe(4);
    expect(caretAfterDigits("30,000,000", 0)).toBe(0);
    expect(caretAfterDigits("30,000,000", 8)).toBe(10);
  });
});
