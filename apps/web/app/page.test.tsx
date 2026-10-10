import { describe, expect, it, vi } from "vitest";

const redirect = vi.fn();
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));

describe("Home page", () => {
  it("redirects / to /chat", async () => {
    const { default: Home } = await import("./page");
    Home();
    expect(redirect).toHaveBeenCalledWith("/chat");
  });
});
