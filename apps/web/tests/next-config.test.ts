import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

describe("next.config redirects", () => {
  it("sends /chat/lead to /chat (Lead's chat is the main chat; coordinator decision, Phase 1)", async () => {
    const redirects = (await nextConfig.redirects?.()) ?? [];
    expect(redirects).toContainEqual({ source: "/chat/lead", destination: "/chat", permanent: false });
  });
});
