import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { researchScanInputFixture } from "@bs-job-agents/shared/fixtures";
import { codexLastMessage, codexLines, STDERR } from "../__fixtures__/index.js";
import { argValue, fakeSpawn, type FakeScript } from "../__fixtures__/fake-cli.js";
import { CONSULT_INPUT, eventLog, makeKit, type Kit } from "../__fixtures__/runner-kit.js";
import { CodexRunner } from "./runner.js";

let kit: Kit;
beforeEach(() => {
  kit = makeKit();
});
afterEach(() => kit.dispose());

const NOW = new Date(2026, 9, 11, 9, 0, 0);

/** Play a capture and write what `-o` (or the repair's `-o`) would hold. */
const play = (lines: string[], over: Partial<FakeScript> = {}): FakeScript => {
  const last = codexLastMessage(lines);
  return {
    stdout: lines,
    stderr: [STDERR.codexStdinNotice],
    exitCode: 0,
    writeFiles: (args) => {
      const out = argValue(args, "-o");
      return out && last !== null ? { [out]: last } : {};
    },
    ...over,
  };
};
const deleteOk: FakeScript = { stdout: [], stderr: [], exitCode: 0 };

function runner(scripts: FakeScript[], plugins: string[] = []) {
  const queue = [...scripts];
  const fake = fakeSpawn((_command, args) => (args[0] === "delete" ? deleteOk : queue.shift() ?? deleteOk));
  const r = new CodexRunner(kit.config(), { spawn: fake.spawn, now: () => NOW.getTime(), codexPluginsToDisable: () => plugins });
  return { r, calls: fake.calls, work: () => fake.calls.filter((c) => c.args[0] === "exec") };
}

const qaConsult = (over = {}) => {
  const { def, cwd } = kit.realBot("qa");
  return kit.task(def, cwd, { kind: "consult", input: CONSULT_INPUT, ...over });
};

describe("CodexRunner: a successful run", () => {
  it("runs codex exec --json in the bot folder and validates the -o output", async () => {
    const { r, calls, work } = runner([play(codexLines("structuredOk"))]);
    const log = eventLog();
    const result = await r.run(qaConsult(), log.onEvent);
    expect(result).toMatchObject({ status: "ok", sessionId: "01a126da-c068-79b0-93c3-7cf34d4305ec" });
    if (result.status === "ok") expect((result.output as { reply: string }).reply).toBe("I run on GPT-6.");
    expect(work()).toHaveLength(1);
    expect(work()[0]!.command).toBe("/fake/codex");
    expect(work()[0]!.options.cwd).toMatch(/bots\/qa$/);
    expect(work()[0]!.args.slice(0, 6)).toEqual(["exec", "--json", "--skip-git-repo-check", "--ignore-user-config", "--disable", "apps"]);
    expect(log.events[0]).toEqual({ type: "started", engine: "codex", sessionId: "01a126da-c068-79b0-93c3-7cf34d4305ec", pid: 10_000 });
    // The thread was persisted for a possible repair; it is deleted afterwards.
    expect(calls.at(-1)!.args).toEqual(["delete", "--force", "01a126da-c068-79b0-93c3-7cf34d4305ec"]);
    expect(kit.workDirsLeft()).toEqual([]);
  });

  it("writes the strict schema into the work dir for --output-schema", async () => {
    let schemaSeen: unknown = null;
    const fake = fakeSpawn((_c, args) => {
      if (args[0] === "delete") return deleteOk;
      schemaSeen = JSON.parse(readFileSync(argValue(args, "--output-schema")!, "utf8"));
      return play(codexLines("structuredOk"));
    });
    const r = new CodexRunner(kit.config(), { spawn: fake.spawn, now: () => NOW.getTime() });
    await r.run(qaConsult(), () => {});
    expect(schemaSeen).toMatchObject({ title: "ConsultOutput", additionalProperties: false });
  });

  it("consult mode: web search off and no MCP servers, even for Research (UC-25)", async () => {
    const { def, cwd } = kit.realBot("research");
    const { r, work } = runner([play(codexLines("structuredOk"))]);
    await r.run(kit.task(def, cwd, { kind: "consult", input: CONSULT_INPUT }), () => {});
    const args = work()[0]!.args;
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain('web_search="disabled"');
  });

  it("Research scan (browser): Ba's config with the other plugins off, host skills skipped, live search", async () => {
    const { def, cwd } = kit.realBot("research");
    const { r, work } = runner([play(codexLines("structuredOk"))], ["browser@openai-bundled"]);
    await r.run(kit.task(def, cwd, { kind: "scan", input: researchScanInputFixture }), () => {});
    const args = work()[0]!.args;
    expect(args).not.toContain("--ignore-user-config");
    expect(args).toContain('plugins."browser@openai-bundled".enabled=false');
    expect(args).toContain("skip_host_skill_discovery");
    expect(args).toContain('web_search="live"');
    // The prompt names the allowed sites (Codex has no hook: prompt-only, §4.4).
    expect(args.at(-1)).toContain("topcv.vn, itviec.com, linkedin.com");
  });
});

describe("CodexRunner: repair in the same thread (§5.5 step 4)", () => {
  it("re-asks once with `codex exec resume <thread>`; the repaired output wins", async () => {
    const { r, work, calls } = runner([play(codexLines("invalidOutput")), play(codexLines("repairOk"))]);
    const log = eventLog();
    const result = await r.run(qaConsult(), log.onEvent);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect((result.output as { reply: string }).reply).toMatch(/PELICAN/);
    const [first, second] = work();
    expect(first!.args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(second!.args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(second!.args).toContain("01a126dc-e579-7312-bbc9-91947b7f50d5");
    expect(second!.args).toContain('sandbox_mode="read-only"');
    expect(second!.args.at(-1)).toMatch(/failed validation against schema ConsultOutput/);
    expect(argValue(second!.args, "-o")).toMatch(/repair\.json$/);
    expect(calls.at(-1)!.args).toEqual(["delete", "--force", "01a126dc-e579-7312-bbc9-91947b7f50d5"]);
  });

  it("a final message that is not JSON gets the repair prompt", async () => {
    const lines = [
      '{"type":"thread.started","thread_id":"01a126dc-0000-7000-8000-000000000009"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Sure! Here is my answer."}}',
      '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
    ];
    const { r, work } = runner([play(lines), play(codexLines("repairOk"))]);
    const result = await r.run(qaConsult(), () => {});
    expect(result.status).toBe("ok");
    expect(work()[1]!.args.at(-1)).toMatch(/not valid JSON/);
  });

  it("still invalid → invalid_output with the raw final message", async () => {
    const { r } = runner([play(codexLines("invalidOutput")), play(codexLines("invalidOutput"))]);
    const result = await r.run(qaConsult(), () => {});
    expect(result).toMatchObject({ status: "invalid_output", errors: ["reply: String must contain at least 1 character(s)"] });
    if (result.status === "invalid_output") expect(result.raw).toContain('"reply":""');
  });

  it("a thread that cannot be resumed → invalid_output naming the repair failure", async () => {
    const { r } = runner([play(codexLines("invalidOutput")), { stdout: [], stderr: [STDERR.codexResumeEphemeral], exitCode: 1 }]);
    const result = await r.run(qaConsult(), () => {});
    expect(result.status).toBe("invalid_output");
    if (result.status === "invalid_output") expect(result.errors.join("\n")).toMatch(/repair failed: .*no rollout found/);
  });
});

describe("CodexRunner: failures and limits", () => {
  it("turn.failed → failed with the API error", async () => {
    const { r } = runner([play(codexLines("turnFailed"), { exitCode: 1 })]);
    const result = await r.run(qaConsult(), () => {});
    expect(result).toMatchObject({ status: "failed", exitCode: 1 });
    if (result.status === "failed") expect(result.error).toMatch(/invalid_json_schema/);
  });

  it("usage limit as the CLI's text (synthetic) → usage_limit at the next 3:45 PM", async () => {
    const { r } = runner([play(codexLines("usageLimit"), { exitCode: 1 })]);
    const log = eventLog();
    const result = await r.run(qaConsult(), log.onEvent);
    expect(result).toMatchObject({ status: "usage_limit", engine: "codex", resetsAt: new Date(2026, 9, 11, 15, 45).toISOString() });
    expect(log.events.find((e) => e.type === "usage")).toMatchObject({ limited: true });
  });

  it("usage limit as the API body (synthetic) → usage_limit at resets_at", async () => {
    const { r } = runner([play(codexLines("usageLimitJson"), { exitCode: 1 })]);
    expect(await r.run(qaConsult(), () => {})).toMatchObject({ status: "usage_limit", resetsAt: new Date(1791670000 * 1000).toISOString() });
  });

  it("times out and cancels like the Claude runner", async () => {
    const { r, work } = runner([{ hang: true }]);
    expect((await r.run(qaConsult({ timeoutMs: 40 }), () => {})).status).toBe("timeout");
    expect(work()[0]!.child.signals[0]).toBe("SIGTERM");
    const two = runner([{ hang: true }]);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    expect((await two.r.run(qaConsult({ signal: ac.signal }), () => {})).status).toBe("cancelled");
  });

  it("refuses a Claude bot", async () => {
    const { def, cwd } = kit.realBot("cv");
    const { r, calls } = runner([play(codexLines("structuredOk"))]);
    const result = await r.run(kit.task(def, cwd, { kind: "consult", input: CONSULT_INPUT }), () => {});
    expect(result).toMatchObject({ status: "failed", error: expect.stringMatching(/runs on claude/) });
    expect(calls).toHaveLength(0);
  });

  it("refuses Apply switched to Codex (S6), before spawning", async () => {
    const { def, cwd } = kit.realBot("apply");
    const { r, calls } = runner([play(codexLines("structuredOk"))]);
    const result = await r.run(kit.task({ ...def, engine: "codex" }, cwd, { kind: "consult", input: CONSULT_INPUT }), () => {});
    expect(result).toMatchObject({ status: "failed", error: expect.stringMatching(/must run on Claude/) });
    expect(calls).toHaveLength(0);
  });
});
