import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { splitApplySubmitInput } from "@bs-job-agents/shared";
import { applyInputFixture, cvTailorInputFixture } from "@bs-job-agents/shared/fixtures";
import { buildSiteGuardSettings } from "../../bridges/chrome/site-guard/settings.js";
import { claudeLines, STDERR } from "../__fixtures__/index.js";
import { argValue, fakeSpawn, type FakeScript } from "../__fixtures__/fake-cli.js";
import { CONSULT_INPUT, eventLog, makeKit, type Kit } from "../__fixtures__/runner-kit.js";
import type { RunnerResult } from "../types.js";
import { ClaudeRunner } from "./runner.js";

let kit: Kit;
beforeEach(() => {
  kit = makeKit();
});
afterEach(() => kit.dispose());

const SID = "11111111-2222-4333-8444-555555555555";
const play = (lines: string[], over: Partial<FakeScript> = {}): FakeScript => ({ stdout: lines, exitCode: 0, ...over });

function runner(scripts: FakeScript[], configOver = {}) {
  const fake = fakeSpawn(scripts);
  const r = new ClaudeRunner(kit.config(configOver), { spawn: fake.spawn, randomUUID: () => SID });
  return { r, calls: fake.calls };
}

const consultTask = (over = {}) => {
  const { def, cwd } = kit.realBot("cv");
  return kit.task(def, cwd, { kind: "consult", input: CONSULT_INPUT, ...over });
};

describe("ClaudeRunner: a successful run", () => {
  it("spawns claude in the bot folder, streams events and returns the validated output", async () => {
    const { r, calls } = runner([play(claudeLines("structuredOk"))]);
    const log = eventLog();
    const result = await r.run(consultTask(), log.onEvent);
    expect(result).toMatchObject({ status: "ok", sessionId: "672a22e9-efad-4750-93c8-0fabbbf6a898" });
    if (result.status === "ok") expect((result.output as { reply: string }).reply).toMatch(/Haiku/);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("/fake/claude");
    expect(calls[0]!.options.cwd).toMatch(/bots\/cv$/);
    expect(log.events[0]).toEqual({ type: "started", engine: "claude", sessionId: "672a22e9-efad-4750-93c8-0fabbbf6a898", pid: 10_000 });
    expect(log.events.find((e) => e.type === "usage")).toMatchObject({ limited: false });
  });

  it("consult mode runs with read-only tools: no Figma server, no hooks, no orchestrator (UC-25)", async () => {
    const { r, calls } = runner([play(claudeLines("structuredOk"))]);
    await r.run(consultTask(), () => {});
    const args = calls[0]!.args;
    expect(argValue(args, "--tools")).toBe("Read");
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--chrome");
    expect(argValue(args, "--settings")).toBe('{"autoMemoryEnabled":false}');
    expect(argValue(args, "--session-id")).toBe(SID);
    expect(args).not.toContain("--no-session-persistence");
  });

  it("writes the transcript: spawn record without the prompt, raw lines, stderr, exit and result", async () => {
    const { r } = runner([play(claudeLines("structuredOk"), { stderr: ["a warning"] })]);
    await r.run(consultTask(), () => {});
    const lines = kit.transcriptLines();
    expect(lines[0]).toMatchObject({ type: "runner.spawn", phase: "initial", engine: "claude", command: "/fake/claude" });
    expect((lines[0]!.args as string[])[1]).toMatch(/^<prompt: \d+ chars>$/);
    const raw = lines.filter((l) => !String(l.type).startsWith("runner."));
    expect(raw).toHaveLength(claudeLines("structuredOk").length);
    expect(lines).toContainEqual({ type: "runner.stderr", phase: "initial", text: "a warning" });
    expect(lines.find((l) => l.type === "runner.exit")).toMatchObject({ exitCode: 0, timedOut: false, cancelled: false });
    expect(lines.at(-1)).toEqual({ type: "runner.result", status: "ok" });
  });

  it("removes its work dir and the persisted session afterwards", async () => {
    const projects = join(kit.claudeConfigDir, "projects", "-bots-cv");
    mkdirSync(projects, { recursive: true });
    const sessionFile = join(projects, "672a22e9-efad-4750-93c8-0fabbbf6a898.jsonl");
    writeFileSync(sessionFile, "{}\n");
    const other = join(projects, "99999999-0000-4000-8000-000000000000.jsonl");
    writeFileSync(other, "{}\n");
    const { r } = runner([play(claudeLines("structuredOk"))]);
    await r.run(consultTask(), () => {});
    expect(existsSync(sessionFile)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(kit.workDirsLeft()).toEqual([]);
  });

  it("keeps the session when cleanup is off", async () => {
    const projects = join(kit.claudeConfigDir, "projects", "-bots-cv");
    mkdirSync(projects, { recursive: true });
    const sessionFile = join(projects, "672a22e9-efad-4750-93c8-0fabbbf6a898.jsonl");
    writeFileSync(sessionFile, "{}\n");
    const { r } = runner([play(claudeLines("structuredOk"))], { cleanupSessions: false });
    await r.run(consultTask(), () => {});
    expect(existsSync(sessionFile)).toBe(true);
  });

  it("a usage event at ≥ 0.95 utilization marks the engine limited but keeps a good result (synthetic)", async () => {
    const { r } = runner([play(claudeLines("highUtilization"))]);
    const log = eventLog();
    const result = await r.run(consultTask(), log.onEvent);
    expect(result.status).toBe("ok");
    expect(log.events.find((e) => e.type === "usage")).toMatchObject({ limited: true, usage: { fiveHour: 0.96 } });
  });

  it("an event listener that throws does not break the run", async () => {
    const { r } = runner([play(claudeLines("structuredOk"))]);
    const result = await r.run(consultTask(), () => {
      throw new Error("listener bug");
    });
    expect(result.status).toBe("ok");
  });
});

describe("ClaudeRunner: repair in the same session (§5.5 step 4)", () => {
  it("re-asks once with --resume <session>, no persistence and every tool off; the repaired output wins", async () => {
    const { r, calls } = runner([play(claudeLines("invalidOutput")), play(claudeLines("repairOk"))]);
    const log = eventLog();
    const result = await r.run(consultTask(), log.onEvent);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect((result.output as { reply: string }).reply).toMatch(/PELICAN/);
    expect(calls).toHaveLength(2);
    const repairArgs = calls[1]!.args;
    expect(argValue(repairArgs, "--resume")).toBe("a1767363-fdae-4ecc-8d91-c03467005daa");
    expect(repairArgs).toContain("--no-session-persistence");
    expect(argValue(repairArgs, "--tools")).toBe("");
    expect(repairArgs).not.toContain("--allowedTools");
    expect(repairArgs).not.toContain("--chrome");
    expect(repairArgs[1]).toMatch(/failed validation against schema ConsultOutput/);
    expect(repairArgs[1]).toContain("reply: String must contain at least 1 character(s)");
    expect(log.events.some((e) => e.type === "progress" && /repair/.test(e.text))).toBe(true);
    const repairNote = kit.transcriptLines().find((l) => l.type === "runner.repair");
    expect(repairNote).toMatchObject({ errors: ["reply: String must contain at least 1 character(s)"] });
  });

  it("a turn that ends without any structured output gets the 'missing output' repair, not a failure", async () => {
    const noOutput = claudeLines("structuredOk").filter((l) => !l.includes('"StructuredOutput"') && !l.includes('"tool_use_id"'));
    const result = noOutput.map((l) => {
      const e = JSON.parse(l) as Record<string, unknown>;
      if (e.type !== "result") return l;
      delete e.structured_output;
      return JSON.stringify({ ...e, result: "Here is my answer in prose." });
    });
    const { r, calls } = runner([play(result), play(claudeLines("repairOk"))]);
    const outcome = await r.run(consultTask(), () => {});
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args[1]).toMatch(/ended without the structured output/);
    expect(outcome.status).toBe("ok");
  });

  it("still invalid after the repair → invalid_output with the errors and the raw output", async () => {
    const { r } = runner([play(claudeLines("invalidOutput")), play(claudeLines("invalidOutput"))]);
    const result = await r.run(consultTask(), () => {});
    expect(result).toMatchObject({ status: "invalid_output", errors: ["reply: String must contain at least 1 character(s)"] });
    if (result.status === "invalid_output") expect(JSON.parse(result.raw!)).toMatchObject({ reply: "" });
  });

  it("a repair that cannot resume the session → invalid_output naming the repair failure", async () => {
    const { r } = runner([play(claudeLines("invalidOutput")), play(claudeLines("resumeNotFound"), { stderr: [STDERR.claudeResumeNotFound], exitCode: 1 })]);
    const result = await r.run(consultTask(), () => {});
    expect(result.status).toBe("invalid_output");
    if (result.status === "invalid_output") expect(result.errors.join("\n")).toMatch(/repair failed: .*No conversation found/);
  });

  it("a repaired output whose self-check failed → self_check_failed (real capture)", async () => {
    const { def, cwd } = kit.customBot({ name: "scout", selfCheck: ["Used both tools once"] });
    const { r } = runner([play(claudeLines("toolsInvalidOutput")), play(claudeLines("repairSelfCheckFailed"))]);
    const result = await r.run(kit.task(def, cwd), () => {});
    expect(result.status).toBe("self_check_failed");
    if (result.status === "self_check_failed") {
      expect(result.failed).toEqual([expect.stringMatching(/^Used both tools once — /)]);
      expect((result.output as { reply: string }).reply).toMatch(/grad-1/);
    }
  });

  it("a missing self-check item is invalid output and gets the repair prompt (rule 4)", async () => {
    const { def, cwd } = kit.customBot({ name: "scout", selfCheck: ["Answered within my role; no work was done", "Checked the second thing"] });
    const { r, calls } = runner([play(claudeLines("structuredOk")), play(claudeLines("structuredOk"))]);
    const result = await r.run(kit.task(def, cwd), () => {});
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args[1]).toContain('selfCheck: missing item "Checked the second thing"');
    expect(result.status).toBe("invalid_output");
  });
});

describe("ClaudeRunner: failures, denials, limits", () => {
  it("real permission denials → denied, with source and reason (no repair)", async () => {
    const { def, cwd } = kit.customBot({ name: "scout", selfCheck: ["Tried every call once"] });
    const { r, calls } = runner([play(claudeLines("mcpAndHookDenied"))]);
    const result = await r.run(kit.task(def, cwd), () => {});
    expect(calls).toHaveLength(1);
    expect(result.status).toBe("denied");
    if (result.status === "denied") {
      expect(result.denials.map((d) => `${d.tool}:${d.source}`)).toEqual(["mcp__echo__wipe:permission", "Read:hook"]);
      expect(result.output).toMatchObject({ selfCheck: [{ item: "Tried every call once" }] });
    }
  });

  it("an errored read is not a denial (spike S1 cross-check): the run is judged on its output", async () => {
    const { def, cwd } = kit.customBot({ name: "scout", selfCheck: ["Tried every file once"] });
    const { r } = runner([play(claudeLines("permissionDenied"))]);
    const result = await r.run(kit.task(def, cwd), () => {});
    expect(result.status).toBe("denied");
    if (result.status === "denied") expect(result.denials).toHaveLength(1);
  });

  it("subscription limit (synthetic) → usage_limit with the reset time", async () => {
    const { r } = runner([play(claudeLines("usageLimit"), { exitCode: 1 })]);
    const log = eventLog();
    const result = await r.run(consultTask(), log.onEvent);
    expect(result).toMatchObject({ status: "usage_limit", engine: "claude", resetsAt: "2026-10-10T20:40:00.000Z" });
    expect(log.events.find((e) => e.type === "usage")).toMatchObject({ limited: true });
  });

  it("an API error → failed with the CLI's message and exit code", async () => {
    const { r } = runner([play(claudeLines("apiError"), { exitCode: 1, stderr: [STDERR.claudeUnknownModel] })]);
    const result = await r.run(consultTask(), () => {});
    expect(result).toMatchObject({ status: "failed", exitCode: 1 });
    if (result.status === "failed") expect(result.error).toMatch(/issue with the selected model/);
  });

  it("a crash with no result → failed with the stderr tail", async () => {
    const { r } = runner([{ stdout: [], stderr: ["boom: segfault"], exitCode: 139 }]);
    const result = await r.run(consultTask(), () => {});
    expect(result).toMatchObject({ status: "failed", exitCode: 139 });
    if (result.status === "failed") expect(result.error).toMatch(/boom: segfault/);
  });

  it("a missing binary → failed, nothing else", async () => {
    const { r } = runner([{ spawnError: "spawn /fake/claude ENOENT" }]);
    expect(await r.run(consultTask(), () => {})).toMatchObject({ status: "failed", exitCode: null, error: expect.stringMatching(/ENOENT/) });
  });
});

describe("ClaudeRunner: timeout and cancel", () => {
  it("kills the process at the task timeout → timeout", async () => {
    const { r, calls } = runner([{ hang: true }]);
    const result = await r.run(consultTask({ timeoutMs: 40 }), () => {});
    expect(result.status).toBe("timeout");
    expect(calls[0]!.child.signals[0]).toBe("SIGTERM");
    expect(kit.workDirsLeft()).toEqual([]);
  });

  it("the timeout covers the repair too", async () => {
    const { r } = runner([play(claudeLines("invalidOutput")), { hang: true }]);
    const result = await r.run(consultTask({ timeoutMs: 150 }), () => {});
    expect(result.status).toBe("timeout");
  });

  it("an AbortSignal kills the process → cancelled", async () => {
    const { r, calls } = runner([{ hang: true }]);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const result: RunnerResult = await r.run(consultTask({ signal: ac.signal }), () => {});
    expect(result.status).toBe("cancelled");
    expect(calls[0]!.child.signals).toContain("SIGTERM");
  });

  it("an already-aborted task never spawns", async () => {
    const { r, calls } = runner([play(claudeLines("structuredOk"))]);
    const ac = new AbortController();
    ac.abort();
    expect(await r.run(consultTask({ signal: ac.signal }), () => {})).toEqual({ status: "cancelled", durationMs: 0 });
    expect(calls).toHaveLength(0);
  });
});

describe("ClaudeRunner: refuses before spawning (fail closed)", () => {
  it.each([
    ["a Codex bot", () => kit.task(kit.realBot("qa").def, kit.realBot("qa").cwd, { kind: "review" }), /runs on codex/],
    [
      "Apply promoted to L2 (S6)",
      () => {
        const { def, cwd } = kit.realBot("apply");
        return kit.task({ ...def, trustLevel: 2 }, cwd, { kind: "submit", input: splitApplySubmitInput(applyInputFixture).prompt, allowedSites: ["itviec.com"] });
      },
      /L1/,
    ],
    [
      "an input carrying the approval token (S5)",
      () => {
        const { def, cwd } = kit.realBot("apply");
        return kit.task(def, cwd, { kind: "submit", input: applyInputFixture, allowedSites: ["itviec.com"] });
      },
      /approvalToken/,
    ],
    [
      "Apply without approved sites",
      () => {
        const { def, cwd } = kit.realBot("apply");
        return kit.task(def, cwd, { kind: "submit", input: splitApplySubmitInput(applyInputFixture).prompt });
      },
      /allowed site/,
    ],
    [
      "a site that is not a host name",
      () => {
        const { def, cwd } = kit.realBot("apply");
        return kit.task(def, cwd, { kind: "submit", input: splitApplySubmitInput(applyInputFixture).prompt, allowedSites: ["https://itviec.com/x"] });
      },
      /not a host name/,
    ],
    ["a relative read dir", () => consultTask({ readDirs: ["data/x"] }), /absolute/],
    ["a read dir with a space", () => consultTask({ readDirs: ["/tmp/my dir"] }), /space/],
    ["a read dir that would break the Read(...) rule", () => consultTask({ readDirs: ["/tmp/a)/**) Read(//"] }), /parenthesis/],
    ["an input that does not match the task schema", () => {
      const { def, cwd } = kit.realBot("cv");
      return kit.task(def, cwd, { kind: "tailor", input: { jobId: 1 } });
    }, /cv\.tailor/],
    ["an unknown task kind", () => {
      const { def, cwd } = kit.realBot("cv");
      return kit.task(def, cwd, { kind: "dance", input: {} });
    }, /no task kind "dance"/],
  ])("%s", async (_label, makeTask, message) => {
    const { r, calls } = runner([play(claudeLines("structuredOk"))]);
    const result = await r.run(makeTask(), () => {});
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.error).toMatch(message);
    expect(calls).toHaveLength(0);
    expect(kit.workDirsLeft()).toEqual([]);
  });

  it("a browser task without the engine's site guard hook (coordinator decision: RunnerTask.hookSettings)", async () => {
    const { def, cwd } = kit.realBot("apply");
    const { r, calls } = runner([play(claudeLines("structuredOk"))]);
    const result = await r.run(
      kit.task(def, cwd, { kind: "submit", input: splitApplySubmitInput(applyInputFixture).prompt, allowedSites: ["itviec.com"], readDirs: [kit.dir("app7")] }),
      () => {},
    );
    expect(result).toMatchObject({ status: "failed", error: expect.stringMatching(/site guard/) });
    expect(calls).toHaveLength(0);
    expect(kit.workDirsLeft()).toEqual([]);
  });

  it("a Figma task without the engine's Figma guard hook", async () => {
    const { def, cwd } = kit.realBot("cv");
    const { r, calls } = runner([play(claudeLines("structuredOk"))]);
    const siteOnly = buildSiteGuardSettings({ allowedSites: ["itviec.com"] });
    const result = await r.run(kit.task(def, cwd, { kind: "tailor", input: cvTailorInputFixture, readDirs: [kit.dir("task9")], hookSettings: siteOnly }), () => {});
    expect(result).toMatchObject({ status: "failed", error: expect.stringMatching(/Figma guard/) });
    expect(calls).toHaveLength(0);
  });
});

describe("guard hooks come from the engine (coordinator decision)", () => {
  it("the task's hook settings, built with W2c's builders, are merged into --settings as they are", async () => {
    const { def, cwd } = kit.realBot("apply");
    const hookSettings = buildSiteGuardSettings({ allowedSites: ["itviec.com", "novapay.breezy.hr"], logFile: join(kit.root, "g.jsonl") });
    const { r, calls } = runner([play(claudeLines("structuredOk"))]);
    await r.run(
      kit.task(def, cwd, { kind: "submit", input: splitApplySubmitInput(applyInputFixture).prompt, allowedSites: ["itviec.com", "novapay.breezy.hr"], readDirs: [kit.dir("app7")], hookSettings }),
      () => {},
    );
    // The fixture answers ConsultOutput, so a repair follows; only the first call has tools and hooks.
    expect(calls).toHaveLength(2);
    const settings = JSON.parse(argValue(calls[0]!.args, "--settings")!) as Record<string, unknown>;
    expect(settings).toEqual({ autoMemoryEnabled: false, hooks: hookSettings.hooks });
    expect(argValue(calls[0]!.args, "--settings")).not.toContain("--sites");
    expect(argValue(calls[1]!.args, "--settings")).toBe('{"autoMemoryEnabled":false}');
    expect(argValue(calls[1]!.args, "--tools")).toBe("");
  });
});

describe("S5: the approval token never reaches the CLI", () => {
  it("Apply gets the prompt input; the token is in no argv, file or transcript", async () => {
    const { def, cwd } = kit.realBot("apply");
    const appDir = kit.dir("applications/7");
    const { r, calls } = runner([play(claudeLines("structuredOk"))]);
    const hookSettings = buildSiteGuardSettings({ allowedSites: ["itviec.com"] });
    const result = await r.run(
      kit.task(def, cwd, { kind: "submit", input: splitApplySubmitInput(applyInputFixture).prompt, allowedSites: ["itviec.com"], readDirs: [appDir], hookSettings }),
      () => {},
    );
    // The fixture answers ConsultOutput, so the Apply output is invalid; what matters is what was sent.
    expect(["invalid_output", "failed"]).toContain(result.status);
    const sent = JSON.stringify(calls.map((c) => c.args));
    expect(sent).not.toContain(applyInputFixture.approvalToken);
    expect(sent).not.toContain("approvalToken");
    expect(readFileSync(kit.transcriptPath, "utf8")).not.toContain(applyInputFixture.approvalToken);
    const args = calls[0]!.args;
    expect(args).toContain("--chrome");
    expect(argValue(args, "--add-dir")).toBe(appDir);
    expect(argValue(args, "--settings")).toContain("'--allow' 'itviec.com'");
  });
});
