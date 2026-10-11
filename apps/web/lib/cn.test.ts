import { describe, expect, it } from "vitest";
import { cn } from "./cn";

describe("cn", () => {
  it("joins class names and skips falsy values", () => {
    expect(cn("a", false, null, undefined, "b")).toBe("a b");
  });

  it("a later Tailwind class overrides a conflicting earlier one (className props win)", () => {
    expect(cn("w-full rounded-xl", "w-28")).toBe("rounded-xl w-28");
    expect(cn("px-3 py-2", "px-5")).toBe("py-2 px-5");
    expect(cn("border-border", "border-warn")).toBe("border-warn");
  });

  it("keeps the theme's colour and size utilities apart", () => {
    expect(cn("text-xs text-muted", "text-fg")).toBe("text-xs text-fg");
    expect(cn("text-muted", "text-[10px]")).toBe("text-muted text-[10px]");
  });
});
