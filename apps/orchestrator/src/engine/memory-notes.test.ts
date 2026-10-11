// PM2 S14: the engine passes each bot's allowlist with its memory notes (Research: its job sites;
// Apply: the task's approved domains; a bot without a browser: none), so the writer drops notes
// that name any other host.
import { applyOutputFixture } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it } from "vitest";
import type { RunnerTask } from "../runner/types.js";
import type { MemoryWriter } from "./ports.js";
import { defaultFakeResult, fake } from "./testing/fake-runner.js";
import { createTestEngine } from "./testing/harness.js";

type Append = Parameters<MemoryWriter["append"]>[0];

function recordingWriter() {
  const calls: Append[] = [];
  const writer: MemoryWriter = {
    append: async (input) => {
      calls.push(input);
    },
  };
  return { calls, writer };
}

const withNotes = (notes: string[]) => (task: RunnerTask) => {
  const r = defaultFakeResult(task);
  return r.status === "ok" ? fake.ok({ ...(r.output as object), memoryNotes: notes }) : r;
};

describe("memory notes carry the bot's allowlist (PM2 S14)", () => {
  it("Research's notes are screened against its job sites, QA's against none", async () => {
    const { calls, writer } = recordingWriter();
    const t = await createTestEngine({ sources: ["itviec"], memory: writer });
    t.runner.script({ bot: "research", kind: "scan", result: withNotes(["itviec.com lists salary under the title"]) });
    t.runner.script({ bot: "qa", kind: "review", result: withNotes(["Check the company name twice"]) });
    t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    await new Promise((r) => setImmediate(r));
    const research = calls.find((c) => c.botName === "research")!;
    expect(research.allowedSites).toEqual(t.engine.deps.bots.get("research")!.browser!.allowedSites);
    expect(research.allowedSites?.length).toBeGreaterThan(0);
    expect(calls.find((c) => c.botName === "qa")!.allowedSites).toEqual([]);
  });

  it("Apply's notes are screened against the approval's domains", async () => {
    const { calls, writer } = recordingWriter();
    const t = await createTestEngine({ sources: ["itviec"], memory: writer });
    const run = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    t.runner.script({
      bot: "apply",
      kind: "submit",
      result: (task) => {
        const input = task.input as { pdfPath: string; pdfSha256: string };
        return fake.ok({
          ...applyOutputFixture,
          status: "needs_check",
          uploadedFile: { filename: input.pdfPath.split("/").at(-1)!, sha256: input.pdfSha256 },
          memoryNotes: ["The itviec form asks for a notice period"],
        });
      },
    });
    t.engine.approve(1, { cvVersionId: t.review(run.id, 1)!.cvVersions[0]!.cvVersionId, introText: null });
    await t.idle();
    await new Promise((r) => setImmediate(r));
    expect(calls.find((c) => c.botName === "apply")!.allowedSites).toEqual(["itviec.com"]);
  });
});
