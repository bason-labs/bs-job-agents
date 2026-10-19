// AD-6 (REQ-3, design §5.4): every research.scan output the orchestrator fetched itself (feeds,
// public and account APIs) settles here, so its postings pass the checks a browser scan's do:
//   1. each posting is validated alone against JobCandidate (and must have its job URL); an
//      invalid one is dropped and named, the rest are kept;
//   2. the research bot's scan self-check items are computed, not trusted: a failed item fails the
//      attempt exactly as a bot-reported one does ("self-check failed: …", retried);
//   3. the ScanOutputChecker (told the output came from an API: no page views, no screenshots);
//   4. the job-scan workflow's dedupe step, as for every source (unchanged).
// The output keeps ResearchScanOutput's shape.
import { JobCandidateSchema, ResearchScanOutputSchema, failedSelfChecks, type Engine as EngineName, type JobCandidate, type ResearchScanOutput, type SelfCheckItem } from "@bs-job-agents/shared";
import { canonicalJobUrl } from "../adapters/index.js";
import { completeTask, getTask, type Conn, type Task } from "../db/index.js";
import type { EngineCore } from "./core.js";
import { MIN_JD_CHARS } from "../adapters/pages.js";
import { cleanText } from "../adapters/text.js";
import { errorMessage } from "./errors.js";
import type { Logger } from "./ports.js";
import { adapterBrokenError, scanRejectedError, type ScanOutputChecker } from "./scan-check.js";
import { emitTaskFinished } from "./task-events.js";

/** bots/research/bot.json selfCheckByKind.scan, in its order. */
export const SCAN_SELF_CHECK_ITEMS = [
  "Every job has a reachable URL",
  "Every job has full JD text (not a snippet)",
  "Every job's language is detected",
  "No job is a duplicate of another in this output",
] as const;

export interface SettleScanInput {
  source: string;
  /** The research.scan task input. */
  taskInput: unknown;
  /** The postings as the fetcher built them (validated here, one by one). */
  jobs: readonly unknown[];
  /** The fetcher's own items, e.g. "Read the Remotive feed directly (no bot, no LLM)". */
  selfCheck: SelfCheckItem[];
  taskId: number;
  runId: number | null;
  attempt: number;
  engine: EngineName;
  checker?: ScanOutputChecker;
  log?: Logger;
}

export type SettleScanResult =
  | { kind: "ok"; output: ResearchScanOutput; dropped: string[] }
  | { kind: "failed"; error: string; retryable: boolean; output?: ResearchScanOutput; dropped: string[] };

function selfCheck(jobs: readonly JobCandidate[]): SelfCheckItem[] {
  const short = jobs.filter((j) => cleanText(j.jdText).length < MIN_JD_CHARS);
  const urls = jobs.map((j) => canonicalJobUrl(j.url!) ?? j.url!);
  const dupes = urls.filter((u, i) => urls.indexOf(u) !== i);
  const noUrl = jobs.filter((j) => !/^https?:\/\//.test(j.url ?? ""));
  const noLang = jobs.filter((j) => !j.language.trim());
  const item = (name: string, bad: readonly unknown[], what: string): SelfCheckItem => ({ item: name, passed: bad.length === 0, note: bad.length === 0 ? null : `${bad.length} ${what}` });
  return [
    item(SCAN_SELF_CHECK_ITEMS[0], noUrl, "without an http(s) URL"),
    item(SCAN_SELF_CHECK_ITEMS[1], short, `with a JD under ${MIN_JD_CHARS} characters`),
    item(SCAN_SELF_CHECK_ITEMS[2], noLang, "without a language"),
    item(SCAN_SELF_CHECK_ITEMS[3], dupes, `duplicate URL${dupes.length === 1 ? "" : "s"}`),
  ];
}

export async function settleScanOutput(input: SettleScanInput): Promise<SettleScanResult> {
  const kept: JobCandidate[] = [];
  const dropped: string[] = [];
  input.jobs.forEach((raw, i) => {
    const parsed = JobCandidateSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      dropped.push(`posting ${i + 1}: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    } else if (parsed.data.url === null) {
      dropped.push(`posting ${i + 1}: no job URL`);
    } else {
      kept.push(parsed.data);
    }
  });
  for (const d of dropped) input.log?.warn(`${input.source} scan (task ${input.taskId}) dropped ${d}`);

  const output = ResearchScanOutputSchema.parse({
    jobs: kept,
    pageViews: 0,
    blocked: null,
    injectionSuspected: false,
    injectionNote: null,
    selfCheck: [...input.selfCheck, ...selfCheck(kept)],
    memoryNotes: [],
  });
  const failed = failedSelfChecks(output.selfCheck).map((i) => i.item);
  if (failed.length > 0) return { kind: "failed", error: `self-check failed: ${failed.join("; ")}`, retryable: true, output, dropped };

  if (!input.checker) return { kind: "ok", output, dropped };
  let verdict;
  try {
    verdict = await input.checker.check({ taskId: input.taskId, runId: input.runId, attempt: input.attempt, engine: input.engine, source: input.source, input: input.taskInput, output, screenshots: [], via: "api" });
  } catch (err) {
    input.log?.warn(`scan check for task ${input.taskId} failed, output accepted: ${errorMessage(err)}`);
    return { kind: "ok", output, dropped };
  }
  if (verdict.ok) return { kind: "ok", output, dropped };
  const reason = verdict.reason.trim() || "the scan output did not pass the source's checks";
  return verdict.adapterBroken
    ? { kind: "failed", error: adapterBrokenError(reason, verdict.screenshot), retryable: false, output, dropped }
    : { kind: "failed", error: scanRejectedError(reason), retryable: true, output, dropped };
}

/** A settled output completes its task (still running: a cancel in the meantime wins); `also` runs in the same transaction. */
export function completeScanTask(core: EngineCore, task: Task, output: ResearchScanOutput, also?: (tx: Conn) => void): void {
  core.db.transaction((tx) => {
    if (getTask(tx, task.id)?.status !== "running") return;
    const done = completeTask(tx, task.id, { output, now: core.now() });
    emitTaskFinished(core, tx, done, "done", null);
    also?.(tx);
  });
}
