// UC-22: the step drawer's transcript, summarised and redacted (never a token, never image data).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TranscriptResponseSchema } from "@bs-job-agents/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createTask } from "../../db/index.js";
import { NOVAPAY, T0, seedApprovedApplication, seedJob } from "../../db/test-helpers.js";
import { createApiHarness, seedCvVersion, writeDataFile, type ApiHarness } from "../testing.js";
import { LINES_MAX, redact, summarizeLine } from "../transcripts.js";

let h: ApiHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const FIXTURE = readFileSync(join(import.meta.dirname, "../../runner/__fixtures__/claude/structured-ok.jsonl"), "utf8");

function task(x: ApiHarness): number {
  return createTask(x.t.db, { runId: null, stepId: null, botName: "research", kind: "fit", engine: "codex", input: {}, promptVersion: 1 }, { now: T0 }).id;
}

describe("GET /tasks/:id/transcript (UC-22)", () => {
  it("summarises a real Claude transcript: session start, text, result", async () => {
    h = await createApiHarness();
    const id = task(h);
    writeDataFile(h.dataDir, `transcripts/${id}-1.jsonl`, FIXTURE);
    const res = await h.get(`/tasks/${id}/transcript`);
    expect(res.statusCode).toBe(200);
    const body = TranscriptResponseSchema.parse(res.json());
    expect(body).toMatchObject({ taskId: String(id), attempt: 1, attempts: [1], truncated: false, running: false });
    expect(body.lines[0]).toMatchObject({ kind: "system", text: expect.stringMatching(/^session started/) });
    expect(body.lines.some((l) => l.kind === "result")).toBe(true);
    // Polling from nextAfter returns nothing new.
    expect(TranscriptResponseSchema.parse((await h.get(`/tasks/${id}/transcript?after=${body.nextAfter}`)).json()).lines).toEqual([]);
  });

  it("redacts approval tokens, capability URLs and image data, and picks the attempt", async () => {
    h = await createApiHarness();
    const job = seedJob(h.t.db, NOVAPAY, T0);
    const cv = seedCvVersion(h.t.db, job);
    const { approval } = seedApprovedApplication(h.t.db, job, cv, { now: T0 });
    const id = task(h);
    const lines = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `token ${approval.token} here` }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__orchestrator__get_status", input: { url: "http://127.0.0.1:5555/mcp/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde" } }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: [{ type: "image", source: { data: "iVBOR".repeat(100) } }, { type: "text", text: "data:image/png;base64,AAAA" }] }] } }),
      "not json at all",
    ];
    writeDataFile(h.dataDir, `transcripts/${id}-1.jsonl`, "{}\n");
    writeDataFile(h.dataDir, `transcripts/${id}-2.jsonl`, `${lines.join("\n")}\n`);
    const res = await h.get(`/tasks/${id}/transcript`);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(approval.token);
    expect(res.body).not.toContain("AbCdEfGh");
    expect(res.body).not.toContain("iVBOR");
    const body = TranscriptResponseSchema.parse(res.json());
    expect(body.attempts).toEqual([1, 2]);
    expect(body.attempt).toBe(2);
    expect(body.lines.map((l) => [l.n, l.kind])).toEqual([
      [1, "text"],
      [2, "tool"],
      [3, "tool_result"],
      [4, "other"],
    ]);
    expect(body.lines[2]!.text).toBe("[image]\n[image]");
    expect(TranscriptResponseSchema.parse((await h.get(`/tasks/${id}/transcript?attempt=1`)).json()).attempt).toBe(1);
  });

  it("404 for an unknown task, a task without a transcript and a missing attempt", async () => {
    h = await createApiHarness();
    const id = task(h);
    expect((await h.get("/tasks/999/transcript")).statusCode).toBe(404);
    expect((await h.get(`/tasks/${id}/transcript`)).statusCode).toBe(404);
    writeDataFile(h.dataDir, `transcripts/${id}-1.jsonl`, "{}\n");
    expect((await h.get(`/tasks/${id}/transcript?attempt=3`)).statusCode).toBe(404);
  });

  it("returns at most LINES_MAX lines (the newest) and says so", async () => {
    h = await createApiHarness();
    const id = task(h);
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "x" }] } });
    writeDataFile(h.dataDir, `transcripts/${id}-1.jsonl`, `${Array.from({ length: LINES_MAX + 20 }, () => line).join("\n")}\n`);
    const body = TranscriptResponseSchema.parse((await h.get(`/tasks/${id}/transcript`)).json());
    expect(body.lines).toHaveLength(LINES_MAX);
    expect(body.truncated).toBe(true);
    expect(body.lines.at(-1)!.n).toBe(LINES_MAX + 20);
  });
});

describe("transcript helpers", () => {
  it("redact() removes 64-hex values, data URIs, long base64 runs and given tokens", () => {
    expect(redact(`a ${"f".repeat(64)} b`)).toBe("a [redacted] b");
    expect(redact("x data:image/jpeg;base64,/9j/4AAQ y")).toBe("x [image] y");
    expect(redact(`k ${"A".repeat(300)}`)).toBe("k [binary]");
    expect(redact("secret-token-value-123 ok", ["secret-token-value-123"])).toBe("[redacted] ok");
  });

  it("summarizeLine() skips thinking and non-init system lines", () => {
    expect(summarizeLine(JSON.stringify({ type: "system", subtype: "thinking_tokens" }))).toEqual([]);
    expect(summarizeLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }] } }))).toEqual([]);
    expect(summarizeLine(JSON.stringify({ type: "runner.exit", code: 0 }))).toEqual([{ kind: "runner", text: 'runner.exit {"code":0}' }]);
  });
});
