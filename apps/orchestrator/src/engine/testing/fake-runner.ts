// FakeRunner (§12): implements the runner contract and replays scripted results and events keyed
// by bot, kind and scenario, including errors (timeout, invalid output, failed self-check, usage
// limit with resetsAt, denial) and the pauses bots report themselves (needs_login, captcha,
// needs_answer, domain_confirm). Without a script it returns a valid default output per task key,
// built from the shared fixtures, so a whole workflow runs end to end.
//
// It works at the contract level (RunnerResult / RunnerEvent). The raw stream-json and
// exec --json captures are replayed by W2b's parser tests (src/runner/__fixtures__).
import { createHash } from "node:crypto";
import { basename } from "node:path";
import {
  CONVERSATION_TASK_KINDS,
  resolveSelfCheckItems,
  type ApplyOutput,
  type CvFactDraftInput,
  type CvOutput,
  type Engine,
  type FactDraftOutput,
  type JobCandidate,
  type PendingQuestion,
  type ResearchScanOutput,
} from "@bs-job-agents/shared";
import {
  applyOutputFixture,
  consultReplyFixture,
  cvOutputFixture,
  leadOutputFixture,
  qaPassFixture,
  researchCompanyFixture,
  researchFitFixture,
  researchScanFixture,
} from "@bs-job-agents/shared/fixtures";
import { SCREENSHOT_MANIFEST, readScreenshotManifest, type CapturedScreenshot } from "../../runner/screenshots.js";
import type { PermissionDenial, Runner, RunnerEvent, RunnerResult, RunnerTask } from "../../runner/types.js";

type ResultFn = (task: RunnerTask, call: number) => RunnerResult | Promise<RunnerResult>;

export interface FakeScript {
  /** Bot name to match (any when omitted). */
  bot?: string;
  /** Task kind to match (any when omitted). */
  kind?: string;
  /** Label for failure messages. */
  scenario?: string;
  /** Extra condition, e.g. on the input's source or the attempt. */
  when?: (task: RunnerTask) => boolean;
  /** Serve at most this many runs, then fall through to older scripts or the defaults. */
  times?: number;
  /** Events emitted after `started`, before the result. */
  events?: RunnerEvent[] | ((task: RunnerTask) => RunnerEvent[]);
  /** Wait on the clock before returning (needs a clock), e.g. to hold a lock while a test looks. */
  delayMs?: number;
  /** Fixed result or a function of the task (default: defaultFakeResult). */
  result?: RunnerResult | ResultFn;
}

interface Sleeper {
  sleep(ms: number): Promise<void>;
}

/** Where the fake writes the screenshots its default Apply output names (a MemoryFileStore). */
export interface ScreenshotSink {
  write(path: string, content: string | Buffer): void;
  read?(path: string): string | undefined;
}

/** The screenshot ids the default Apply output names (PM2 S7: the ids the Chrome tool showed). */
export const FAKE_APPLY_SCREENSHOTS = { preSubmit: "ss_fake_pre", confirmation: "ss_fake_conf", jdPage: "ss_fake_jd" } as const;

/** A minimal PNG header: enough for the record's magic-byte check. */
export const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

/**
 * PM2 S7: what the runner's ScreenshotCapture leaves for one attempt: `<dir>/<n>.<ext>` files and
 * manifest.json (earlier entries kept), returned as RunnerResult.screenshots.
 */
export function fakeCaptures(
  sink: ScreenshotSink,
  dir: string,
  shots: Array<{ id: string | null; bytes?: Buffer; toolUseId?: string }>,
): CapturedScreenshot[] {
  const earlier = readScreenshotManifest(sink.read?.(`${dir}/${SCREENSHOT_MANIFEST}`) ?? null);
  const out: CapturedScreenshot[] = [];
  for (const [i, shot] of shots.entries()) {
    const bytes = shot.bytes ?? FAKE_PNG;
    const n = earlier.length + i + 1;
    const ext = bytes[0] === 0xff ? "jpg" : "png";
    const file = `${n}.${ext}`;
    sink.write(`${dir}/${file}`, bytes);
    out.push({
      n,
      file,
      screenshotId: shot.id,
      toolUseId: shot.toolUseId ?? `toolu_fake_${n}`,
      tool: "mcp__claude-in-chrome__computer",
      mediaType: ext === "jpg" ? "image/jpeg" : "image/png",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      capturedAt: "2026-10-11T03:00:00.000Z",
    });
  }
  sink.write(`${dir}/${SCREENSHOT_MANIFEST}`, JSON.stringify({ version: 1, screenshots: [...earlier, ...out] }));
  return out;
}

const pass = (item: string) => ({ item, passed: true, note: null });
const ms = 1200;

/** RunnerResult builders, one per scenario. */
export const fake = {
  ok(output: unknown, sessionId: string | null = null): RunnerResult {
    return { status: "ok", output, sessionId, durationMs: ms };
  },
  timeout(): RunnerResult {
    return { status: "timeout", durationMs: 600_000 };
  },
  invalidOutput(errors: string[] = ["total: Required"], raw: string | null = "{}"): RunnerResult {
    return { status: "invalid_output", errors, raw, durationMs: ms };
  },
  selfCheckFailed(output: unknown, failed: string[]): RunnerResult {
    return { status: "self_check_failed", output, failed, durationMs: ms };
  },
  usageLimit(engine: Engine, resetsAt: string | null): RunnerResult {
    return { status: "usage_limit", engine, resetsAt, durationMs: ms };
  },
  denied(denials: PermissionDenial[], output: unknown | null = null): RunnerResult {
    return { status: "denied", denials, output, durationMs: ms };
  },
  failed(error: string, exitCode: number | null = 1): RunnerResult {
    return { status: "failed", error, exitCode, durationMs: ms };
  },
  cancelled(): RunnerResult {
    return { status: "cancelled", durationMs: ms };
  },
  /** UC-03 a / UC-17: Research reports that a source needs Ba to log in. */
  needsLogin(site: string): RunnerResult {
    return fake.ok(blockedScan("needs_login", site));
  },
  /** UC-17: a CAPTCHA stopped the scan. */
  captcha(site: string): RunnerResult {
    return fake.ok(blockedScan("captcha", site));
  },
  /** UC-11 a/b, UC-12, UC-17: Apply paused itself (pending questions, login or CAPTCHA). */
  applyPaused(
    pause:
      | { questions: PendingQuestion[] }
      | { reason: "needs_login" | "captcha" | "domain_confirm"; site: string; detail?: string | null },
  ): RunnerResult {
    return fake.ok(pausedApply(pause));
  },
  /** UC-11 e: the site guard blocked a navigation off the approved domains and Apply paused for Ba. */
  applyDomainConfirm(site: string): RunnerResult {
    return fake.denied(
      [{ tool: "mcp__claude-in-chrome__navigate", input: { url: `https://${site}/apply` }, source: "hook", reason: `${site} is not an approved site` }],
      pausedApply({ reason: "domain_confirm", site }),
    );
  },
};

function blockedScan(reason: "needs_login" | "captcha", site: string): ResearchScanOutput {
  return {
    jobs: [],
    pageViews: 1,
    blocked: { reason, site, detail: reason === "needs_login" ? "the site shows a sign-in wall" : "a CAPTCHA is shown" },
    injectionSuspected: false,
    injectionNote: null,
    selfCheck: [pass("Every job has a reachable URL")],
    memoryNotes: [],
  };
}

function pausedApply(
  pause:
    | { questions: PendingQuestion[] }
    | { reason: "needs_login" | "captcha" | "domain_confirm"; site: string; detail?: string | null },
): ApplyOutput {
  const questions = "questions" in pause ? pause.questions : [];
  return {
    status: "paused",
    fieldsFilled: [{ label: "Full name", name: "fullname", value: "Ba Huynh", source: "master_cv", required: true }],
    introText: null,
    consent: null,
    uploadedFile: null,
    preSubmitScreenshot: null,
    confirmationScreenshot: null,
    confirmationText: null,
    finalUrl: null,
    pendingQuestions: questions,
    pauseReason:
      "questions" in pause
        ? { reason: "needs_answer", site: null, detail: "required fields with no saved answer" }
        : { reason: pause.reason, site: pause.site, detail: pause.detail ?? null },
    jdSnapshot: null,
    injectionSuspected: false,
    injectionNote: null,
    selfCheck: [pass("All required fields are filled")],
    memoryNotes: [],
  };
}

const ascii = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toUpperCase();

/** `<COMPANY>_<ROLE>-J<jobId>_<LANG>_v<round>`: the CV naming rule, unique per job (§6.2). */
export function fakeFrameName(input: { jobId?: unknown; job?: { company?: string; title?: string }; language?: string; round?: unknown }): string {
  const company = ascii(input.job?.company ?? "COMPANY").replace(/[^A-Z0-9]/g, "") || "COMPANY";
  const role = ascii(input.job?.title ?? "ROLE").replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "ROLE";
  const lang = input.language === "vi" ? "VI" : "EN";
  return `${company}_${role}-J${String(input.jobId ?? "0")}_${lang}_v${Number(input.round ?? 1)}`;
}

/**
 * cv.fact_draft as a faithful CV would answer: one fact that is Ba's own sentence (so it passes the
 * invented-detail guard), at the organisation he names, or none when he says no.
 */
export function fakeFactDraft(input: CvFactDraftInput): FactDraftOutput {
  const text = input.text.trim();
  if (/^(no|nope|không|chưa)\b/i.test(text)) return { facts: [], notes: "You said no, so I added nothing.", selfCheck: [], memoryNotes: [] };
  const role = input.existingFacts.find((f) => f.org && text.toLowerCase().includes(f.org.toLowerCase()));
  const prefix = role ? role.id.replace(/-\d+$/, "") : "skill";
  const taken = input.existingFacts.map((f) => new RegExp(`^${prefix}-(\\d+)$`).exec(f.id)).filter((m) => m !== null).map((m) => Number(m[1]));
  const sentence = text.replace(/^(yes|có)[,.!\s]+/i, "");
  const fact = {
    id: `${prefix}-${(taken.length ? Math.max(...taken) : 0) + 1}`,
    type: role ? ("experience" as const) : ("skill" as const),
    text: sentence.charAt(0).toUpperCase() + sentence.slice(1),
    textVi: sentence,
    tags: input.question ? [input.question.topic.toLowerCase()] : [],
    org: role?.org ?? null,
    dates: role?.dates ?? null,
  };
  return { facts: [fact], notes: null, selfCheck: [], memoryNotes: [] };
}

function candidate(base: JobCandidate, over: Partial<JobCandidate>): JobCandidate {
  return { ...base, ...over };
}

/**
 * A valid output for every Phase 1 task key, shaped by the task input. Its selfCheck lists every
 * item of the task's bot and kind (resolveSelfCheckItems), as the real runner requires (rule 4).
 */
export function defaultFakeResult(task: RunnerTask): RunnerResult {
  const result = baseFakeResult(task);
  if (result.status !== "ok" || typeof result.output !== "object" || result.output === null) return result;
  const selfCheck = resolveSelfCheckItems(task.bot, task.kind).map((item) => pass(item));
  return { ...result, output: { ...(result.output as Record<string, unknown>), selfCheck } };
}

function baseFakeResult(task: RunnerTask): RunnerResult {
  const key = `${task.bot.name}.${task.kind}`;
  const input = (task.input ?? {}) as Record<string, unknown>;
  const novapay = researchScanFixture.jobs[0]!;
  switch (key) {
    case "research.scan": {
      // The browser opened each job page it returns (the runner reports the URLs Chrome showed).
      const jobs = researchScanFixture.jobs.filter((j) => j.source === input.source);
      return { ...fake.ok({ ...researchScanFixture, jobs }), pageUrls: jobs.map((j) => j.url!).filter(Boolean), openedUrls: jobs.map((j) => j.url!).filter(Boolean) };
    }
    case "research.single":
      return fake.ok({ ...researchScanFixture, jobs: [candidate(novapay, { source: "link", url: String(input.url ?? novapay.url) })] });
    case "research.file":
      return fake.ok({ ...researchScanFixture, jobs: [candidate(novapay, { source: "file" })] });
    case "research.repair":
      // Skill self-repair: the current skill with one layout line added, as a faithful redraft would be.
      return fake.ok({
        skillMd: String(input.currentSkill ?? "").replace(/^(## \d+\. Listing page[^\n]*\n)/m, "$1- Cards are now `article.job-card`.\n"),
        otherChanges: [],
        notes: "The listing's card element changed.",
        pageViews: 2,
        blocked: null,
        injectionSuspected: false,
        injectionNote: null,
        selfCheck: [],
        memoryNotes: [],
      });
    case "research.fit":
      return fake.ok(researchFitFixture);
    case "research.company": {
      const website = typeof input.website === "string" ? input.website : researchCompanyFixture.company.website;
      return fake.ok({
        ...researchCompanyFixture,
        company: { ...researchCompanyFixture.company, name: String(input.name ?? researchCompanyFixture.company.name), website },
      });
    }
    case "cv.tailor": {
      const output: CvOutput = {
        ...cvOutputFixture,
        language: input.language === "vi" ? "vi" : "en",
        figmaFrameName: fakeFrameName(input as Parameters<typeof fakeFrameName>[0]),
        factRequests: [],
      };
      return fake.ok(output);
    }
    case "cv.fact_draft":
      return fake.ok(fakeFactDraft(input as unknown as CvFactDraftInput));
    case "cv.derive":
      // A careful CV finds nothing it can support (tests script real drafts).
      return fake.ok({ drafts: [], memoryNotes: [] });
    case "qa.review":
      return fake.ok(qaPassFixture);
    case "cv.review": {
      // A satisfied reviewer: every rule it was given is met (tests script misses).
      const rules = Array.isArray(input.rules) ? (input.rules as { ruleId: string }[]) : [];
      return fake.ok({ items: rules.map((r) => ({ ruleId: r.ruleId, status: "met", reason: "Met.", fixable: false, fix: null, needsFact: null })), memoryNotes: [] });
    }
    case "research.guidance_extract":
      // Nothing new on the changed pages (tests script drafts).
      return fake.ok({ drafts: [], injectionSuspected: false, injectionNote: null, memoryNotes: [] });
    case "research.guidance_discover":
      return fake.ok({ urls: [], memoryNotes: [] });
    case "apply.submit": {
      const pdfPath = typeof input.pdfPath === "string" ? input.pdfPath : "/data/applications/0/CV.pdf";
      const sha256 = typeof input.pdfSha256 === "string" ? input.pdfSha256 : applyOutputFixture.uploadedFile!.sha256;
      const uploaded = { filename: basename(pdfPath), sha256 };
      const shots = {
        preSubmitScreenshot: FAKE_APPLY_SCREENSHOTS.preSubmit,
        confirmationScreenshot: FAKE_APPLY_SCREENSHOTS.confirmation,
        jdSnapshot: applyOutputFixture.jdSnapshot ? { ...applyOutputFixture.jdSnapshot, pageScreenshot: FAKE_APPLY_SCREENSHOTS.jdPage } : null,
      };
      const output: ApplyOutput =
        input.dryRun === true
          ? { ...applyOutputFixture, ...shots, status: "needs_check", uploadedFile: uploaded, confirmationScreenshot: null, confirmationText: null }
          : { ...applyOutputFixture, ...shots, uploadedFile: uploaded };
      return fake.ok(output);
    }
    case "lead.chat":
      return fake.ok(leadOutputFixture);
    default:
      if ((CONVERSATION_TASK_KINDS as readonly string[]).includes(task.kind)) return fake.ok(consultReplyFixture);
      return fake.failed(`FakeRunner has no output for ${key}`);
  }
}

export class FakeRunner implements Runner {
  readonly engine: Engine | "fake";
  readonly calls: RunnerTask[] = [];
  /** Runs in flight right now. */
  running = 0;
  private readonly scripts: (FakeScript & { used: number })[] = [];
  private readonly active = new Map<string, number>();
  private readonly peaks = new Map<string, number>();
  private peakAll = 0;
  private readonly clock: Sleeper | undefined;
  private readonly screenshots: ScreenshotSink | undefined;

  /**
   * `screenshots`: where the default Apply output's screenshots are written (its application
   * folder), standing in for the capture pipeline (PM2 S7), so a default Apply is recorded clean.
   * Scripted results name their own screenshots and write nothing.
   */
  constructor(opts: { clock?: Sleeper; engine?: Engine | "fake"; scripts?: FakeScript[]; screenshots?: ScreenshotSink } = {}) {
    this.clock = opts.clock;
    this.screenshots = opts.screenshots;
    this.engine = opts.engine ?? "fake";
    for (const s of opts.scripts ?? []) this.script(s);
  }

  /** Add scripts; the newest matching one wins. */
  script(...entries: FakeScript[]): this {
    for (const e of entries) this.scripts.push({ ...e, used: 0 });
    return this;
  }

  /** Sessions the engine asked to remove (UC-18 orphan cleanup), in order. */
  readonly removedSessions: string[] = [];

  async removeSession(sessionId: string): Promise<void> {
    this.removedSessions.push(sessionId);
  }

  /** Calls of one task key, e.g. "apply.submit". */
  callsFor(key: string): RunnerTask[] {
    return this.calls.filter((c) => `${c.bot.name}.${c.kind}` === key);
  }

  /** Highest number of concurrent runs seen, for one task key or overall. */
  maxConcurrent(key?: string): number {
    return key === undefined ? this.peakAll : (this.peaks.get(key) ?? 0);
  }

  async run(task: RunnerTask, onEvent: (event: RunnerEvent) => void): Promise<RunnerResult> {
    this.calls.push(task);
    const call = this.calls.length;
    const key = `${task.bot.name}.${task.kind}`;
    const entry = this.match(task);
    this.enter(key);
    try {
      if (task.signal?.aborted) return fake.cancelled();
      onEvent({ type: "started", engine: task.bot.engine, sessionId: `fake-${task.taskId}-${task.attempt}`, pid: 40_000 + call });
      const events = typeof entry?.events === "function" ? entry.events(task) : (entry?.events ?? []);
      for (const e of events) onEvent(e);
      if (entry?.delayMs) {
        if (!this.clock) throw new Error(`FakeRunner: script "${entry.scenario ?? key}" has a delay but no clock`);
        if (await this.wait(entry.delayMs, task.signal)) return fake.cancelled();
      }
      if (task.signal?.aborted) return fake.cancelled();
      const result = entry?.result;
      if (result === undefined) {
        const answer = defaultFakeResult(task);
        // PM2 S7: like the runner, the screenshots the default Apply output names exist as captures.
        if (key === "apply.submit" && answer.status === "ok" && this.screenshots && task.screenshotDir) {
          const out = answer.output as ApplyOutput;
          const ids = [out.preSubmitScreenshot, out.confirmationScreenshot, out.jdSnapshot?.pageScreenshot].filter((x): x is string => typeof x === "string");
          return { ...answer, screenshots: fakeCaptures(this.screenshots, task.screenshotDir, ids.map((id) => ({ id }))) };
        }
        return answer;
      }
      return typeof result === "function" ? await result(task, call) : result;
    } finally {
      this.leave(key);
    }
  }

  private match(task: RunnerTask): (FakeScript & { used: number }) | undefined {
    for (let i = this.scripts.length - 1; i >= 0; i--) {
      const s = this.scripts[i]!;
      if (s.bot !== undefined && s.bot !== task.bot.name) continue;
      if (s.kind !== undefined && s.kind !== task.kind) continue;
      if (s.times !== undefined && s.used >= s.times) continue;
      if (s.when && !s.when(task)) continue;
      s.used++;
      return s;
    }
    return undefined;
  }

  private wait(delayMs: number, signal: AbortSignal | undefined): Promise<boolean> {
    return new Promise((resolve) => {
      const onAbort = () => resolve(true);
      signal?.addEventListener("abort", onAbort, { once: true });
      void this.clock!.sleep(delayMs).then(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve(false);
      });
    });
  }

  private enter(key: string): void {
    this.running++;
    this.peakAll = Math.max(this.peakAll, this.running);
    const n = (this.active.get(key) ?? 0) + 1;
    this.active.set(key, n);
    this.peaks.set(key, Math.max(this.peaks.get(key) ?? 0, n));
  }

  private leave(key: string): void {
    this.running--;
    this.active.set(key, (this.active.get(key) ?? 1) - 1);
  }
}
