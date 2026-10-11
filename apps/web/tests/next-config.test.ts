import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

describe("next.config redirects", () => {
  it("sends /chat/lead to /chat (Lead's chat is the main chat; coordinator decision, Phase 1)", async () => {
    const redirects = (await nextConfig.redirects?.()) ?? [];
    expect(redirects).toContainEqual({ source: "/chat/lead", destination: "/chat", permanent: false });
  });
});

describe("next.config rewrites (same-origin /api proxy to the orchestrator, PM S18)", () => {
  it("forwards /api/* to the orchestrator, for localhost requests only", async () => {
    const rewrites = await nextConfig.rewrites?.();
    expect(rewrites).toEqual([
      expect.objectContaining({ source: "/api/:path*", destination: "http://127.0.0.1:4100/:path*", has: [expect.objectContaining({ type: "host" })] }),
    ]);
  });
});
