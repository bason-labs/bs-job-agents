// F8 (live bug 2026-10-11: Lead "can't read the screenshot"): the files Ba attaches to a chat
// message reach the bot answering it. Claude gets Read on the task's attachments folder only (Lead:
// nothing else, rule 5); Codex gets the images with `-i <file>`; the prompt lists them as untrusted.
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cvTailorInputFixture } from "@bs-job-agents/shared/fixtures";
import { codexLastMessage, codexLines, claudeLines, STDERR } from "./__fixtures__/index.js";
import { argValue, fakeSpawn, type FakeScript } from "./__fixtures__/fake-cli.js";
import { CONSULT_INPUT, makeKit, type Kit } from "./__fixtures__/runner-kit.js";
import { ClaudeRunner } from "./claude/runner.js";
import { CodexRunner } from "./codex/runner.js";
import type { RunnerAttachment, RunnerTask } from "./types.js";

let kit: Kit;
let dir: string;
let shot: RunnerAttachment;
let jd: RunnerAttachment;
beforeEach(() => {
  kit = makeKit();
  dir = join(kit.root, "data", "tasks", "42", "attachments");
  shot = { path: join(dir, "upload-3.png"), name: "Screenshot at Oct 11 5-14-30 PM.png", mime: "image/png" };
  jd = { path: join(dir, "upload-4.pdf"), name: "JD (final).pdf", mime: "application/pdf" };
});
afterEach(() => kit.dispose());

const LEAD_CHAT = { ...CONSULT_INPUT, uploadIds: ["3", "4"], handoff: null };
const ORCHESTRATOR_TOOLS = ["start_workflow", "create_task", "get_status", "get_result", "message_user", "propose_workflow"].map((t) => `mcp__orchestrator__${t}`);

function claude() {
  const fake = fakeSpawn(() => ({ stdout: claudeLines("structuredOk"), exitCode: 0 }));
  return { r: new ClaudeRunner(kit.config(), { spawn: fake.spawn, randomUUID: () => "11111111-2222-4333-8444-555555555555" }), calls: fake.calls };
}

function codex() {
  const lines = codexLines("structuredOk");
  const last = codexLastMessage(lines);
  const answer: FakeScript = {
    stdout: lines,
    stderr: [STDERR.codexStdinNotice],
    exitCode: 0,
    writeFiles: (args) => {
      const out = argValue(args, "-o");
      return out && last !== null ? { [out]: last } : {};
    },
  };
  const fake = fakeSpawn((_c, args) => (args[0] === "delete" ? { stdout: [], exitCode: 0 } : answer));
  return { r: new CodexRunner(kit.config(), { spawn: fake.spawn }), calls: fake.calls };
}

const leadTask = (over: Partial<RunnerTask> = {}) => {
  const { def, cwd } = kit.realBot("lead");
  return kit.task(def, cwd, { kind: "chat", input: LEAD_CHAT, attachments: [shot, jd], readDirs: [dir], ...over });
};

/** Every value of a repeated flag (--allowedTools takes a list: up to the next flag). */
function listAfter(args: readonly string[], flag: string): string[] {
  const i = args.indexOf(flag);
  if (i < 0) return [];
  const out: string[] = [];
  for (const a of args.slice(i + 1)) {
    if (a.startsWith("--")) break;
    out.push(a);
  }
  return out;
}

describe("Claude: Read on the attachments folder only (F8)", () => {
  it("lead.chat with a screenshot: Read for that folder and nothing else (rule 5); the prompt lists the files as untrusted", async () => {
    const { r, calls } = claude();
    await r.run(leadTask(), () => {});
    const args = calls[0]!.args;
    expect(argValue(args, "--tools")).toBe("Read");
    expect(listAfter(args, "--allowedTools")).toEqual([`Read(/${dir}/**)`, ...ORCHESTRATOR_TOOLS]);
    expect(listAfter(args, "--add-dir")).toEqual([dir]);
    expect(args).not.toContain("--chrome");
    expect(args.filter((a) => a.startsWith("Read("))).toEqual([`Read(/${dir}/**)`]);
    const prompt = args[1]!;
    expect(prompt).toMatch(
      /<<<UNTRUSTED_CONTENT id="[0-9a-f]{12}" field="attachments">>>\n- name: Screenshot at Oct 11 5-14-30 PM\.png\n {2}type: image\/png\n {2}path: .*upload-3\.png\n- name: JD \(final\)\.pdf\n {2}type: application\/pdf\n {2}path: .*upload-4\.pdf\n<<<END_UNTRUSTED_CONTENT/,
    );
    expect(prompt).toContain("Ba attached 2 files to his message");
    expect(prompt).toContain("Look at each one with the Read tool at its path");
    // Lead has no `read` tool: its readDirs never become a "you may read" line.
    expect(prompt).not.toContain("you may read only");
  });

  it("without attachments Lead keeps exactly its six orchestrator tools", async () => {
    const { r, calls } = claude();
    await r.run(leadTask({ attachments: undefined, readDirs: undefined, input: { ...LEAD_CHAT, uploadIds: [] } }), () => {});
    const args = calls[0]!.args;
    expect(argValue(args, "--tools")).toBe("");
    expect(listAfter(args, "--allowedTools")).toEqual(ORCHESTRATOR_TOOLS);
    expect(args).not.toContain("--add-dir");
    expect(args[1]).not.toContain('field="attachments"');
  });

  it("a consult (CV has read): the attachments folder is its one read dir, granted once", async () => {
    const { r, calls } = claude();
    const { def, cwd } = kit.realBot("cv");
    await r.run(kit.task(def, cwd, { kind: "consult", input: { ...CONSULT_INPUT, uploadIds: ["3"] }, attachments: [shot], readDirs: [dir] }), () => {});
    const args = calls[0]!.args;
    expect(args.filter((a) => a.startsWith("Read("))).toEqual([`Read(/${dir}/**)`]);
    expect(listAfter(args, "--add-dir")).toEqual([dir]);
    expect(args[1]).toContain("Ba attached a file to his message");
  });

  it.each([
    ["attachments on a work task", () => kit.task(kit.realBot("cv").def, kit.realBot("cv").cwd, { kind: "tailor", input: cvTailorInputFixture, attachments: [shot] }), /takes no attachments/],
    ["files in two folders", () => leadTask({ attachments: [shot, { ...jd, path: join(kit.root, "data", "elsewhere", "upload-4.pdf") }] }), /not an orchestrator copy/],
    ["a name the orchestrator did not make", () => leadTask({ attachments: [{ ...shot, path: join(dir, "Screenshot.png") }] }), /not an orchestrator copy/],
    ["a path that would break the Read(...) rule", () => leadTask({ attachments: [{ ...shot, path: join(dir, "upload-3).png") }] }), /parenthesis/],
    ["a relative path", () => leadTask({ attachments: [{ ...shot, path: "data/tasks/42/attachments/upload-3.png" }] }), /absolute/],
    ["a type a bot cannot view", () => leadTask({ attachments: [{ ...shot, mime: "application/msword" }] }), /cannot be shown/],
  ])("refuses %s before spawning", async (_label, makeTask, message) => {
    const { r, calls } = claude();
    const result = await r.run(makeTask(), () => {});
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.error).toMatch(message);
    expect(calls).toHaveLength(0);
  });
});

describe("Codex: images with -i (F8)", () => {
  it("a QA consult gets each image with -i right after exec (never before the prompt); the PDF is listed by path", async () => {
    const { r, calls } = codex();
    const { def, cwd } = kit.realBot("qa");
    const second = { ...shot, path: join(dir, "upload-5.jpg"), name: "photo.jpg", mime: "image/jpeg" };
    await r.run(kit.task(def, cwd, { kind: "consult", input: { ...CONSULT_INPUT, uploadIds: ["3", "4", "5"] }, attachments: [shot, jd, second], readDirs: [dir] }), () => {});
    const args = calls.find((c) => c.args[0] === "exec")!.args;
    expect(args.slice(0, 6)).toEqual(["exec", "-i", shot.path, "-i", second.path, "--json"]);
    expect(args.filter((a) => a === "-i")).toHaveLength(2);
    expect(args).not.toContain(jd.path);
    expect(args).toContain("read-only");
    const prompt = args.at(-1)!;
    expect(prompt).toContain(`path: ${jd.path}`);
    expect(prompt).toContain("The images come with this prompt");
  });

  it("no attachments, no -i", async () => {
    const { r, calls } = codex();
    const { def, cwd } = kit.realBot("qa");
    await r.run(kit.task(def, cwd, { kind: "consult", input: CONSULT_INPUT }), () => {});
    expect(calls.find((c) => c.args[0] === "exec")!.args).not.toContain("-i");
  });
});
