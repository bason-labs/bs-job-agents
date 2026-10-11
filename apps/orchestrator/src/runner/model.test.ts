import { describe, expect, it } from "vitest";
import { modelForEngine, modelSuitsEngine } from "./model.js";

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

describe("modelSuitsEngine (PATCH /bots/:name { model })", () => {
  it("refuses a Claude model on Codex and an OpenAI model on Claude", () => {
    expect(modelSuitsEngine("opus", "claude")).toBe(true);
    expect(modelSuitsEngine("claude-sonnet-4-5", "claude")).toBe(true);
    expect(modelSuitsEngine("gpt-5-codex", "codex")).toBe(true);
    expect(modelSuitsEngine("o3", "codex")).toBe(true);
    expect(modelSuitsEngine("sonnet", "codex")).toBe(false);
    expect(modelSuitsEngine("gpt-5", "claude")).toBe(false);
    expect(modelSuitsEngine("o3", "claude")).toBe(false);
  });
});
