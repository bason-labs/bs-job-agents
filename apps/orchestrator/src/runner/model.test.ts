import { describe, expect, it } from "vitest";
import { modelForEngine } from "./model.js";

describe("modelForEngine", () => {
  it("keeps a model meant for the engine", () => {
    expect(modelForEngine("sonnet", "claude")).toBe("sonnet");
    expect(modelForEngine("gpt-5", "codex")).toBe("gpt-5");
  });
  it("drops a model meant for the other engine (engine switched in the UI)", () => {
    expect(modelForEngine("sonnet", "codex")).toBeNull();
    expect(modelForEngine("claude-sonnet-5-5", "codex")).toBeNull();
    expect(modelForEngine("gpt-5", "claude")).toBeNull();
  });
  it("null means the CLI default", () => {
    expect(modelForEngine(null, "claude")).toBeNull();
  });
});
