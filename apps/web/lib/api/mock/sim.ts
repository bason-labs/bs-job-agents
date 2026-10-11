// The bots' side of the mock orchestrator: Lead's replies (UC-01, UC-14, UC-21b a, UC-24),
// consult hand-offs (UC-25), group rooms (UC-15), job-scan / apply-to-link / apply-to-file runs
// with per-job lanes and the CV ⇄ QA gate (UC-03..07), review decisions (UC-08..10), Apply's
// questions (UC-12) and pauses (UC-11 e, UC-16, UC-17). Timings are short and scaled by `speed`.
import {
  cvLanguagesForJd,
  normalizeAnswerKey,
  parseMentions,
  type Application,
  type ApplicationStatus,
  type Company,
  type CvLanguage,
  type CvVersion,
  type Job,
  type MessageCard,
  type PauseReason,
  type QaReviewRecord,
  type ReviewCard,
  type Room,
  type Run,
  type SkipDecision,
  type Task,
} from "@bs-job-agents/shared";
import type { ApproveInput, ApproveResult } from "../contract";
import type { MockBackend, SimulationKind } from "./backend";
import { LEAD_ROOM_ID, cvVersion, pdfFileId, qaRecord, selfCheckFor } from "./seed";
import type { LaneInfo, MockPause, RunState } from "./state";

type Core = MockBackend;

export class RunCancelled extends Error {
  constructor() {
    super("run cancelled");
  }
}

const LEAD = { type: "bot", bot: "lead" } as const;
const LANG = (l: CvLanguage) => l.toUpperCase();
const SOURCE_LABEL: Record<string, string> = { topcv: "TopCV", itviec: "ITviec", linkedin: "LinkedIn", link: "link", file: "file" };

export const mentionsIn = (text: string, bots: readonly string[]) => parseMentions(text, bots);

// ---------------------------------------------------------------- catalog of jobs scans find

interface CatalogJob {
  job: Job;
  company: Company;
  /** QA totals per language, round by round. */
  qa: Partial<Record<CvLanguage, number[]>>;
}

function catalogJob(id: string, o: Partial<Job> & { title: string; company: string; source: string; url: string | null; fit: number }, profile: { industry: string; size: string; kind: "product" | "outsource" | "mixed"; low?: boolean }, qa: CatalogJob["qa"]): CatalogJob {
  const job: Job = {
    id,
    source: o.source,
    url: o.url,
    canonicalUrl: o.url,
    dedupeHash: `${o.company}|${o.title}`.toLowerCase(),
    title: o.title,
    companyId: `co-${id}`,
    company: o.company,
    location: o.location ?? "Ho Chi Minh City",
    workMode: o.workMode ?? "hybrid",
    salaryText: o.salaryText ?? null,
    language: o.language ?? "en",
    jdText: o.jdText ?? `${o.title} — ${o.company}\n\nRequirements\n- React, TypeScript\n- 3+ years frontend`,
    fitScore: o.fit,
    fitReasons: o.fitReasons ?? ["React + TypeScript match", "Product company"],
    gaps: o.gaps ?? [],
    status: "selected",
    skipReason: null,
    skipNote: null,
    injectionFlagged: false,
    injectionClearedAt: null,
    firstSeenAt: new Date().toISOString(),
  };
  const sources = profile.low
    ? [{ title: "LinkedIn company page", url: `https://www.linkedin.com/company/${id}` }]
    : [
        { title: `${o.company} careers`, url: `https://careers.example.com/${id}` },
        { title: "ITviec company page", url: `https://itviec.com/companies/${id}` },
      ];
  const company: Company = {
    id: `co-${id}`,
    name: o.company,
    website: `https://${o.company.toLowerCase().replace(/[^a-z]+/g, "")}.example.com`,
    profile: {
      name: o.company,
      website: null,
      industry: profile.industry,
      size: profile.size,
      productOrOutsource: profile.kind,
      culture: ["ownership", "small teams"],
      benefits: ["13th month", "hybrid"],
      reviewsSummary: null,
      sources,
      confidence: profile.low ? "low_confidence" : "normal",
      researchedAt: new Date().toISOString(),
    },
    confidence: profile.low ? "low_confidence" : "normal",
    researchedAt: new Date().toISOString(),
  };
  return { job, company, qa };
}

/** What successive scans find: two jobs each, then nothing (UC-04 a). */
function scanCatalog(): CatalogJob[][] {
  return [
    [
      catalogJob("201", { title: "Frontend Engineer (React)", company: "Lumen Health", source: "itviec", url: "https://itviec.com/it-jobs/frontend-engineer-react-lumen-health-2201", salaryText: "1,800–2,500 USD", fit: 84 }, { industry: "Health tech", size: "~120 people", kind: "product" }, { en: [86] }),
      catalogJob(
        "202",
        { title: "Trưởng nhóm Frontend (React/Next.js)", company: "Orbit Logistics", source: "topcv", url: "https://www.topcv.vn/viec-lam/truong-nhom-frontend-react-nextjs/2340002.html", salaryText: "40–55 triệu", language: "vi", workMode: "onsite", fit: 78, gaps: ["Wants team-lead experience"] },
        { industry: "Logistics", size: "~400 people", kind: "mixed" },
        { vi: [74, 82], en: [81] },
      ),
    ],
    [
      catalogJob("203", { title: "Frontend Developer (Next.js)", company: "Mây Software", source: "topcv", url: "https://www.topcv.vn/viec-lam/frontend-developer-nextjs/2340003.html", salaryText: "30–40 triệu", language: "vi", fit: 81 }, { industry: "SaaS", size: "~60 people", kind: "product" }, { vi: [83], en: [84] }),
      catalogJob("204", { title: "Frontend Engineer", company: "Hachi Retail", source: "linkedin", url: "https://www.linkedin.com/jobs/view/4019999999", workMode: "remote", fit: 76, gaps: ["Asks for Vue 3"] }, { industry: "Retail", size: "~50 people", kind: "product", low: true }, { en: [71, 77, 79] }),
    ],
  ];
}

// The catalog is per backend instance (each tab starts fresh).
const catalogs = new WeakMap<Core, { scans: CatalogJob[][]; byJob: Map<string, CatalogJob> }>();
function catalog(core: Core) {
  let c = catalogs.get(core);
  if (!c) {
    c = { scans: scanCatalog(), byJob: new Map() };
    catalogs.set(core, c);
  }
  return c;
}

// ---------------------------------------------------------------- run plumbing

function nextRunId(core: Core): string {
  const ids = Object.keys(core.state.runs).map(Number).filter(Number.isFinite);
  return String(Math.max(12, ...ids) + 1);
}

function createRun(core: Core, workflowName: string, trigger: Run["trigger"], params: unknown, scheduleId: string | null = null): RunState {
  const id = nextRunId(core);
  const run: Run = {
    id,
    workflowName,
    workflowVersion: 1,
    trigger,
    params,
    searchProfileVersion: core.state.criteriaVersion,
    scheduleId,
    status: "running",
    createdAt: core.nowIso(),
    finishedAt: null,
  };
  const state: RunState = { run, steps: [], tasks: [], lanes: [] };
  core.state.runs[id] = state;
  core.emit({ type: "run.started", runId: id, workflowName, trigger, scheduleId });
  return state;
}

async function checkpoint(core: Core, runId: string): Promise<void> {
  for (;;) {
    const status = core.state.runs[runId]?.run.status;
    if (!status || status === "cancelled") throw new RunCancelled();
    if (status !== "paused") return;
    await core.wait(150);
  }
}

const BROWSER_TASKS = new Set(["research.scan", "research.single", "apply.submit"]);

/** Waits while the bot's engine is paused for its usage limit (UC-16) or Chrome is closed (needs_browser). */
async function gate(core: Core, runId: string | null, bot: string, kind: string): Promise<void> {
  const engine = core.state.bots.find((b) => b.name === bot)?.engine ?? "claude";
  for (;;) {
    if (runId) await checkpoint(core, runId);
    const paused = core.state.engines.find((e) => e.engine === engine)?.pausedUntil;
    const noBrowser = BROWSER_TASKS.has(`${bot}.${kind}`) && !core.state.chromeConnected;
    if (!paused && !noBrowser) return;
    await core.wait(200);
  }
}

type Line = [kind: "text" | "tool_use" | "tool_result" | "status", text: string, tool?: string];

/** One task on a step: started, a few transcript lines, finished. */
async function work(core: Core, runId: string, stepKey: string, branchKey: string | null, bot: string, kind: string, input: unknown, lines: Line[], output: unknown, ms = 700): Promise<Task> {
  await gate(core, runId, bot, kind);
  const row = core.findStep(runId, stepKey, branchKey);
  const task = core.startTask(runId, row?.id ?? null, bot, kind, input);
  const pace = ms / (lines.length + 1);
  for (const [k, text, tool] of [["status", `task started · cwd bots/${bot}`] as Line, ...lines]) {
    await core.wait(pace);
    if (core.state.runs[runId]?.run.status === "cancelled") throw new RunCancelled();
    core.progress(task, k, text, tool ?? null);
  }
  await core.wait(pace);
  await checkpoint(core, runId);
  core.progress(task, "status", "validating output schema ✓");
  core.finishTask(task, "done", output);
  return task;
}

export function runIsWaitingOnlyForBa(r: RunState): boolean {
  return !r.tasks.some((t) => t.status === "running" || t.status === "queued") && r.steps.some((s) => s.stepKey === "review" && s.status === "waiting");
}

/** A run whose every lane is decided (and Apply done or skipped) is done. */
function maybeFinishRun(core: Core, runId: string | null): void {
  if (!runId) return;
  const r = core.state.runs[runId];
  if (!r || ["done", "failed", "cancelled"].includes(r.run.status)) return;
  const open = r.steps.some((s) => ["pending", "running", "waiting", "locked", "paused"].includes(s.status) && s.stepKey !== "apply") ||
    r.steps.some((s) => s.stepKey === "apply" && ["running", "paused"].includes(s.status)) ||
    r.steps.some((s) => s.stepKey === "apply" && s.status === "locked" && r.steps.some((h) => h.stepKey === "review" && h.branchKey === s.branchKey && h.status === "waiting"));
  if (open) {
    const next = runIsWaitingOnlyForBa(r) ? "waiting" : "running";
    if (r.run.status !== next && r.run.status !== "paused") {
      r.run.status = next;
      core.emit({ type: "run.updated", runId, status: next });
    }
    return;
  }
  r.run.status = "done";
  r.run.finishedAt = core.nowIso();
  core.emit({ type: "run.finished", runId, status: "done", summary: "every job decided" });
}

// ---------------------------------------------------------------- lanes (UC-05..07)

function laneJob(core: Core, jobId: string): CatalogJob | null {
  const known = catalog(core).byJob.get(jobId);
  if (known) return known;
  const card = core.state.queue.concat(core.acted).find((c) => c.job.id === jobId);
  if (!card) return null;
  const qa: CatalogJob["qa"] = {};
  for (const o of card.cvOptions) qa[o.cvVersion.language] = [Math.min(95, (o.qaRounds.at(-1)?.total ?? 76) + 4)];
  return { job: card.job, company: card.company!, qa };
}

async function runLane(core: Core, r: RunState, lane: LaneInfo, opts: { from?: "company" | "tailor"; comment?: string | null } = {}): Promise<void> {
  const runId = r.run.id;
  const cat = laneJob(core, lane.jobId);
  if (!cat) return;
  const { job, company } = cat;
  if (opts.from !== "tailor") {
    core.setStep(runId, "company", lane.jobId, "running", { preview: `profiling ${company.name}` });
    const profile = company.profile;
    await work(core, runId, "company", lane.jobId, "research", "company", { name: company.name, website: company.website }, [
      ["tool_use", `Searching ${company.name} reviews and size`, "web_search"],
      ["tool_result", `${profile?.sources.length ?? 1} sources`, "web_search"],
    ], { company: profile, selfCheck: selfCheckFor("research", "company"), memoryNotes: [] });
    core.setStep(runId, "company", lane.jobId, "done", {
      preview: `${company.name} · ${profile?.confidence === "low_confidence" ? "low confidence" : `${profile?.productOrOutsource ?? "unknown"} · ${profile?.sources.length ?? 0} sources`}`,
      output: { company: profile, cacheHit: false },
    });
  }

  const options: ReviewCard["cvOptions"] = [];
  for (const language of cvLanguagesForJd(job.language)) {
    const branchKey = `${lane.jobId}:${language}`;
    const previous = core.findStep(runId, "tailor", branchKey)?.output as { pass?: number; rounds?: unknown[] } | null | undefined;
    const pass = (previous?.pass ?? 0) + 1;
    const priorRounds = (previous?.rounds ?? []) as object[];
    const earlier = core.acted.concat(core.state.queue).find((c) => c.job.id === lane.jobId)?.cvOptions.find((o) => o.cvVersion.language === language);
    const qaRounds: QaReviewRecord[] = [...(earlier?.qaRounds ?? [])];
    const plan = cat.qa[language] ?? [82];
    const out = { jobId: Number(lane.jobId), language, pass, comment: opts.comment ?? null, rounds: [...priorRounds], outcome: "running", cvVersionId: null as number | null };
    let last: CvVersion | null = null;
    for (let i = 0; i < plan.length && i < 3; i++) {
      const round = i + 1;
      const versionNo = (earlier?.cvVersion.round ?? 0) + round;
      core.setStep(runId, "tailor", branchKey, "running", { round, preview: `CV ${LANG(language)} round ${round}`, output: out });
      const cvTask = await work(core, runId, "tailor", branchKey, "cv", "tailor", { jobId: lane.jobId, language, round, comment: opts.comment ?? null }, [
        ["tool_use", "Duplicating the template frame into Drafts", "figma_execute"],
        ["tool_use", "Writing bullets from master facts", "figma_execute"],
        ["status", "Exporting the PDF"],
      ], { language, changeNotes: [], factRequests: [], selfCheck: selfCheckFor("cv", "tailor"), memoryNotes: [] }, 900);
      last = cvVersion(core.nextId(), lane.jobId, company.name, language, versionNo, core.nowIso());
      core.state.fileUrls[pdfFileId(last.id)] = "/dev/sample-cv.pdf";
      core.setStep(runId, "tailor", branchKey, "running", { round, preview: `CV ${LANG(language)} round ${round}: QA reviewing`, output: out });
      const total = plan[i]!;
      const qaTask = await work(core, runId, "tailor", branchKey, "qa", "review", { jobId: lane.jobId, cvVersionId: last.id }, [
        ["tool_use", "Reading the exported PDF text", "read_file"],
        ["text", `Scoring against the JD: ${total}`],
      ], { total, selfCheck: selfCheckFor("qa", "review"), memoryNotes: [] }, 600);
      const qa = qaRecord(core.nextId(), last.id, total, core.nowIso());
      qaRounds.push(qa);
      out.rounds.push({ pass, round, producerTaskId: Number(cvTask.id), cvVersionId: Number(last.id), checkerTaskId: Number(qaTask.id), qaReviewId: Number(qa.id), total, passed: qa.passed });
      if (qa.passed) {
        out.outcome = "passed";
        out.cvVersionId = Number(last.id);
        core.setStep(runId, "tailor", branchKey, "done", { round, preview: `QA ${total} · passed`, output: out });
        break;
      }
      if (round < 3 && i < plan.length - 1) {
        core.setStep(runId, "tailor", branchKey, "running", { round, preview: `QA ${total} · revising (round ${round + 1} of 3)`, output: out });
      } else {
        out.outcome = "escalated";
        out.cvVersionId = Number(last.id);
        core.setStep(runId, "tailor", branchKey, "done", { round, preview: `QA not passed after ${round} rounds`, output: out });
        break;
      }
    }
    if (last) {
      options.push({ cvVersion: last, qaRounds, pdf: { id: pdfFileId(last.id), kind: "cv_pdf", filename: `${last.figmaFrameName}.pdf`, mime: "application/pdf" } });
    }
  }

  await checkpoint(core, runId);
  const passed = options.every((o) => o.qaRounds.at(-1)!.passed);
  const card: ReviewCard = {
    job: { ...job, status: "reviewing" },
    company,
    runId,
    cvOptions: options,
    defaultLanguage: options.some((o) => o.cvVersion.language === "vi") ? "vi" : options[0]!.cvVersion.language,
    introText: null,
    factRequests: [],
    flags: {
      qaPassed: passed,
      escalated: !passed,
      needsInput: false,
      injectionFlagged: job.injectionFlagged && job.injectionClearedAt === null,
      masterChanged: false,
      noApplyLink: job.url === null,
      lowConfidenceCompany: company.confidence === "low_confidence",
    },
    readyAt: core.nowIso(),
  };
  core.acted = core.acted.filter((c) => c.job.id !== lane.jobId);
  core.state.queue = [...core.state.queue.filter((c) => c.job.id !== lane.jobId), card];
  core.setStep(runId, "review", lane.jobId, "waiting", { preview: passed ? "waiting for Ba" : "QA not passed · Ba decides" });
  const apply = core.findStep(runId, "apply", lane.jobId);
  if (!apply || apply.status === "pending" || apply.status === "skipped") core.setStep(runId, "apply", lane.jobId, "locked", { preview: "unlocks after approval" });
  core.emit({
    type: "review.ready",
    jobId: lane.jobId,
    runId,
    company: company.name,
    title: job.title,
    cvVersionIds: options.map((o) => o.cvVersion.id),
    qaPassed: passed,
    escalated: !passed,
    needsInput: false,
    injectionFlagged: card.flags.injectionFlagged,
  });
}

// ---------------------------------------------------------------- workflows (UC-01, UC-02, UC-14, UC-24)

async function scanSources(core: Core, r: RunState, found: CatalogJob[]): Promise<void> {
  const runId = r.run.id;
  const sources = ["topcv", "itviec", "linkedin"];
  const counts = { total: 3, queued: 3, running: 0, done: 0, failed: 0 };
  core.setStep(runId, "scan", null, "running", { preview: "×3", counts: { ...counts }, output: { taskKey: "research.scan", items: [], counts } });
  const items: object[] = [];
  let total = 0;
  for (const [i, source] of sources.entries()) {
    counts.queued--;
    counts.running = 1;
    core.setStep(runId, "scan", null, "running", { preview: `${SOURCE_LABEL[source]} · ${i}/3 done`, counts: { ...counts } });
    const n = 8 + i * 3;
    total += n;
    const task = await work(core, runId, "scan", null, "research", "scan", { source, criteria: { version: core.state.criteriaVersion } }, [
      ["tool_use", `Opening ${SOURCE_LABEL[source]} search results`, "cua_repl"],
      ["tool_result", `${n} results on page 1`, "cua_repl"],
      ["text", `Collected ${n} jobs`],
    ], { jobs: [], pageViews: n, blocked: null, selfCheck: selfCheckFor("research", "scan"), memoryNotes: [] }, 800);
    items.push({ item: source, taskId: Number(task.id), status: "done", output: { found: n } });
    counts.running = 0;
    counts.done++;
  }
  const fresh = Math.max(found.length, Math.round(total * 0.6));
  core.setStep(runId, "scan", null, "done", { preview: `${total} found → ${fresh} new`, counts: { ...counts }, output: { taskKey: "research.scan", items, counts } });
  core.setStep(runId, "scan-join", null, "done", { preview: "3 ok" });
  core.setStep(runId, "dedupe", null, "done", { preview: `${fresh} new · ${total - fresh} seen before`, output: { items: [] } });
  await scoreFit(core, r, fresh, found);
  core.setStep(runId, "fit-join", null, "done", { preview: `${fresh} ok` });
}

async function scoreFit(core: Core, r: RunState, n: number, found: CatalogJob[]): Promise<void> {
  const runId = r.run.id;
  const counts = { total: n, queued: n, running: 0, done: 0, failed: 0 };
  core.setStep(runId, "fit", null, "running", { preview: `×${n}`, counts: { ...counts } });
  const items: object[] = [];
  for (let i = 0; i < n; i++) {
    const cat = found[i];
    const score = cat?.job.fitScore ?? 55 - i;
    const task = await work(core, runId, "fit", null, "research", "fit", { jobId: cat?.job.id ?? String(800 + i), masterCvVersion: 3 }, [], {
      fit: { score, reasons: cat?.job.fitReasons ?? ["Some overlap"], gaps: cat?.job.gaps ?? [] },
      selfCheck: selfCheckFor("research", "fit"),
      memoryNotes: [],
    }, 120);
    items.push({ item: { title: cat ? `${cat.job.title} — ${cat.job.company}` : `Candidate ${i + 1}` }, taskId: Number(task.id), jobId: Number(cat?.job.id ?? 800 + i), status: "done", output: { score } });
    counts.queued--;
    counts.done++;
    if (i % 4 === 3 || i === n - 1) core.setStep(runId, "fit", null, i === n - 1 ? "done" : "running", { preview: `${counts.done} done, 0 failed`, counts: { ...counts }, output: { taskKey: "research.fit", items, counts } });
  }
}

async function runLanes(core: Core, r: RunState, found: CatalogJob[], filterKey: string, preview: string): Promise<void> {
  const runId = r.run.id;
  r.lanes = found.map((c) => ({ jobId: c.job.id, title: c.job.title, company: c.job.company }));
  for (const c of found) catalog(core).byJob.set(c.job.id, c);
  core.setStep(runId, filterKey, null, "done", { preview, output: { items: r.lanes.map((l) => ({ jobId: Number(l.jobId), title: l.title, company: l.company })) } });
  await Promise.all(r.lanes.map((lane) => runLane(core, r, lane)));
}

async function readyMessage(core: Core, r: RunState, found: CatalogJob[]): Promise<void> {
  await checkpoint(core, r.run.id);
  maybeFinishRun(core, r.run.id);
  const list = found
    .map((c) => {
      const card = core.state.queue.find((x) => x.job.id === c.job.id);
      return `${c.job.company} ${c.job.fitScore}${card && !card.flags.qaPassed ? " (QA not passed — needs your decision)" : ""}`;
    })
    .join(" · ");
  await core.post(LEAD_ROOM_ID, LEAD, `🎯 **${found.length} ${found.length === 1 ? "job" : "jobs"} ready for review**: ${list}.`, {
    cards: [{ type: "review_link", count: core.state.queue.length }],
    runIds: [r.run.id],
    stream: true,
  });
}

async function jobScan(core: Core, r: RunState): Promise<void> {
  const found = catalog(core).scans.shift() ?? [];
  await scanSources(core, r, found);
  if (found.length === 0) {
    core.setStep(r.run.id, "top", null, "done", { preview: "0 jobs ≥ 60", output: { items: [] } });
    r.run.status = "done";
    r.run.finishedAt = core.nowIso();
    core.emit({ type: "run.finished", runId: r.run.id, status: "done", summary: "no strong matches" });
    await core.post(LEAD_ROOM_ID, LEAD, "No strong matches this time: every new job scored below your fit threshold (60). Want me to widen the search?", { runIds: [r.run.id], stream: true });
    return;
  }
  await runLanes(core, r, found, "top", `${found.length} jobs ≥ 60`);
  await readyMessage(core, r, found);
}

async function applyToLink(core: Core, r: RunState, url: string): Promise<void> {
  const runId = r.run.id;
  core.setStep(runId, "scan", null, "running", { preview: "reading the job page" });
  await work(core, runId, "scan", null, "research", "single", { url }, [
    ["tool_use", "Opening the job link", "cua_repl"],
    ["text", "Read the full JD"],
  ], { jobs: [], pageViews: 1, blocked: null, selfCheck: selfCheckFor("research", "single"), memoryNotes: [] }, 900);
  core.setStep(runId, "scan", null, "done", { preview: "1 JobCandidate" });
  const found = [catalogJob(core.nextId(), { title: "Frontend Engineer (Next.js)", company: "Hyperion Labs", source: "itviec", url, fit: 85, salaryText: "2,000–3,000 USD" }, { industry: "Developer tools", size: "~90 people", kind: "product" }, { en: [87] })];
  await scoreFit(core, r, 1, found);
  core.setStep(runId, "fit-join", null, "done", { preview: "1 ok" });
  await runLanes(core, r, found, "selected", "1 job");
  await readyMessage(core, r, found);
}

async function applyToFile(core: Core, r: RunState, filename: string): Promise<void> {
  const runId = r.run.id;
  core.setStep(runId, "scan", null, "running", { preview: `reading ${filename}` });
  await work(core, runId, "scan", null, "research", "file", { uploadId: filename }, [["tool_use", `Reading ${filename}`, "read_file"]], { jobs: [], pageViews: 0, blocked: null, selfCheck: selfCheckFor("research", "file"), memoryNotes: [] }, 800);
  core.setStep(runId, "scan", null, "done", { preview: "1 JobCandidate · no apply link found" });
  const name = filename.replace(/\.[^.]+$/, "").replace(/^(jd|job)[\s_-]*/i, "").replace(/[_-]+/g, " ").trim() || "Acme Corp";
  const found = [catalogJob(core.nextId(), { title: "Frontend Engineer", company: name, source: "file", url: null, fit: 80 }, { industry: "Software", size: "unknown", kind: "product", low: true }, { en: [84] })];
  await scoreFit(core, r, 1, found);
  core.setStep(runId, "fit-join", null, "done", { preview: "1 ok" });
  await runLanes(core, r, found, "selected", "1 job");
  await readyMessage(core, r, found);
}

// ---------------------------------------------------------------- chat

const URL_RE = /https?:\/\/[^\s<>"]+/;
const WORK_RE = /\b(find|scan|search|apply|submit|tailor|make|create|update|generate|rewrite|fix)\b/i;

const CONSULT_ANSWERS: Record<string, string> = {
  research:
    "Short answer: product companies in HCM are hiring mostly mid/senior React + TypeScript; Next.js shows up in about 60% of the JDs I scanned this week. Want more AI-focused roles? Ask Lead to change your criteria.",
  cv: "I would lead with ownership and scale: “~300 employees across 4 countries” is your strongest line. For AI roles I put the CV-screening project first. Everything I write is traced to your master facts.",
  qa: "I score JD match 40, company tone 20, format/ATS 20, clarity 20. Pass is ≥ 80 with no hard fails — invented facts, wrong language, wrong company, or more than 1 page.",
  apply: "I have 3 saved answers (expected salary, notice period, work permit). I always stop before submit unless you approved that exact job, and I only work on that job's site.",
};

const ROOM_ANSWERS: Record<string, string> = {
  cv: "From my side: I can draft two variants and let QA pick. I only use facts already in your master data.",
  qa: "I would score this on JD keyword coverage first; tone second. Happy to run a dry score.",
  research: "I can pull 3 example JDs for that role so we compare against real requirements.",
  apply: "I don't act in rooms (discussion mode). Approve a review card and I'll handle the form.",
  lead: 'Want me to turn this into a task? Say "@Lead make it a task".',
};

export async function replyTo(core: Core, room: Room, message: { text: string; uploadIds: string[] }): Promise<void> {
  if (room.kind === "lead") return leadBrain(core, message.text, message.uploadIds);
  if (room.kind === "direct") return consult(core, room, message.text, message.uploadIds);
  return groupRoom(core, room, message.text);
}

async function leadBrain(core: Core, text: string, uploadIds: string[]): Promise<void> {
  await core.wait(500);
  const files = uploadIds.map((id) => core.state.uploads[id]?.filename).filter((n): n is string => !!n);
  const url = URL_RE.exec(text)?.[0];
  if (files.length) {
    const r = createRun(core, "apply-to-file", "chat", { uploadId: uploadIds[0], searchProfileId: null });
    await core.post(LEAD_ROOM_ID, LEAD, `Got **${files.join(", ")}**. Research will read the job description from the file, then company → CV → QA → your review.`, {
      cards: [{ type: "run", runId: r.run.id }],
      runIds: [r.run.id],
      stream: true,
    });
    return applyToFile(core, r, files[0]!);
  }
  if (url) {
    const r = createRun(core, "apply-to-link", "link", { url, applyAgain: false, searchProfileId: null });
    await core.post(LEAD_ROOM_ID, LEAD, "Got the link. Starting **apply-to-link**: Research reads the JD, then company → CV → QA → your review.", {
      cards: [{ type: "run", runId: r.run.id }],
      runIds: [r.run.id],
      stream: true,
    });
    return applyToLink(core, r, url);
  }
  if (/\b(also|include)\b/i.test(text) && /(đà nẵng|da nang)/i.test(text)) {
    await core.post(LEAD_ROOM_ID, LEAD, "Add **Đà Nẵng** just for this run, or save it to your search criteria?", {
      cards: [{ type: "choice", key: "criteria", options: [{ id: "once", label: "Just this run" }, { id: "save", label: "Save to my criteria" }], chosen: null }],
      stream: true,
    });
    return;
  }
  if (/\b(status|progress|where)\b/i.test(text)) {
    const active = Object.values(core.state.runs).map((r) => r.run).filter((r) => ["running", "waiting", "paused"].includes(r.status)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const reply = active
      ? `Run #${active.id} is **${active.status}**. ${core.state.queue.length} ${core.state.queue.length === 1 ? "card is" : "cards are"} waiting for you in Review.`
      : `No run is in progress. ${core.state.queue.length} ${core.state.queue.length === 1 ? "card is" : "cards are"} waiting for you in Review.`;
    await core.post(LEAD_ROOM_ID, LEAD, reply, { stream: true });
    return;
  }
  if (/\b(find|scan|search|look for|jobs?)\b/i.test(text)) {
    const scanning = Object.values(core.state.runs).find((r) => r.run.workflowName === "job-scan" && r.run.status === "running");
    if (scanning) {
      await core.post(LEAD_ROOM_ID, LEAD, `Job scan #${scanning.run.id} is still running — I'll fold this into the next one.`, { stream: true });
      return;
    }
    const r = createRun(core, "job-scan", "chat", { searchProfileId: null, overrides: null });
    await core.post(LEAD_ROOM_ID, LEAD, `Started **Job scan #${r.run.id}** using search criteria v${core.state.criteriaVersion}. Delegating now.`, {
      cards: [{ type: "run", runId: r.run.id }],
      runIds: [r.run.id],
      stream: true,
    });
    return jobScan(core, r);
  }
  await core.post(
    LEAD_ROOM_ID,
    LEAD,
    "I can find jobs, apply to a link or a JD file, or change your search criteria. Try: “Find frontend jobs in HCM, React/Next.js, ≥ 25M”.",
    { stream: true },
  );
}

async function consult(core: Core, room: Room, text: string, uploadIds: string[]): Promise<void> {
  const botName = room.botName ?? "research";
  const display = core.state.bots.find((b) => b.name === botName)?.displayName ?? botName;
  await core.wait(600);
  const files = uploadIds.map((id) => core.state.uploads[id]?.filename).filter((n): n is string => !!n);
  if (WORK_RE.test(text) || files.length) {
    const request = text || files.join(", ");
    await core.post(room.id, { type: "bot", bot: botName }, "That's a work request, so I've passed it to Lead — Lead assigns all work (rule 1 & 5). You'll see the progress in the Lead chat.", {
      cards: [{ type: "handoff", fromBot: botName, request }],
      stream: true,
    });
    await core.post(LEAD_ROOM_ID, LEAD, `📨 Handed over from **@${display}**: Ba asked “${request}”. I'll plan it and assign the work.`, {
      cards: [{ type: "handoff", fromBot: botName, request }],
    });
    return leadBrain(core, text, uploadIds);
  }
  await core.post(room.id, { type: "bot", bot: botName }, CONSULT_ANSWERS[botName] ?? "Happy to explain anything within my role.", { stream: true });
}

async function groupRoom(core: Core, room: Room, text: string): Promise<void> {
  const mentions = mentionsIn(text, core.state.bots.map((b) => b.name));
  await core.wait(400);
  if (mentions.length === 0) {
    await core.post(room.id, { type: "system" }, "No bot mentioned — type @ to ask a specific bot.");
    return;
  }
  for (const bot of mentions) {
    await core.wait(500);
    await core.post(room.id, { type: "bot", bot }, ROOM_ANSWERS[bot] ?? "Noted.", { stream: true });
  }
}

export async function afterChoice(core: Core, roomId: string, key: string, optionId: string): Promise<void> {
  await core.wait(300);
  if (key !== "criteria") {
    await core.post(roomId, LEAD, "Noted.");
    return;
  }
  if (optionId === "save") {
    core.state.criteriaVersion++;
    await core.post(roomId, LEAD, `Saved to your search criteria (now **v${core.state.criteriaVersion}**). The next scan includes Đà Nẵng.`, { stream: true });
  } else {
    await core.post(roomId, LEAD, "OK — Đà Nẵng only for the next run. Your saved criteria stay the same.", { stream: true });
  }
}

// ---------------------------------------------------------------- review decisions (UC-08..10)

function moveApplication(core: Core, app: Application, status: ApplicationStatus, note: string | null = null): void {
  app.status = status;
  app.statusHistory.push({ status, at: core.nowIso(), note });
  if (status === "submitted") app.submittedAt = core.nowIso();
  core.emit({ type: "application.updated", applicationId: app.id, jobId: app.jobId, status, origin: "app" });
}

interface ApplyCtx {
  runId: string;
  jobId: string;
  company: string;
  host: string;
  app: Application;
  task: Task;
  dryRun: boolean;
}

const applyCtx = new WeakMap<Task, ApplyCtx>();

export function approve(core: Core, card: ReviewCard, option: ReviewCard["cvOptions"][number], input: ApproveInput): ApproveResult {
  const jobId = card.job.id;
  const runId = card.runId!;
  core.state.queue = core.state.queue.filter((c) => c.job.id !== jobId);
  core.acted = [...core.acted.filter((c) => c.job.id !== jobId), card];
  const dryRun = input.dryRun === true;
  if (!card.job.url) {
    core.setStep(runId, "review", jobId, "done", { preview: "approved · no apply link" });
    core.setStep(runId, "apply", jobId, "skipped", { preview: "no apply link" });
    core.background(
      core.post(LEAD_ROOM_ID, LEAD, `Approved **${card.job.company}**. There's no apply link for this job, so I only made the PDF (${option.pdf?.filename ?? "CV"}).`, { runIds: [runId] }).then(() => maybeFinishRun(core, runId)),
    );
    return { applicationId: null, taskId: null, approval: null, reapproval: false };
  }
  const host = new URL(card.job.url).hostname.replace(/^www\./, "");
  const app: Application = {
    id: core.nextId(),
    jobId,
    cvVersionId: option.cvVersion.id,
    submittedAt: null,
    status: "approved",
    origin: "app",
    statusHistory: [{ status: "approved", at: core.nowIso(), note: dryRun ? "dry run" : null }],
    dryRun,
  };
  core.state.applications[app.id] = app;
  core.emit({ type: "application.updated", applicationId: app.id, jobId, status: "approved", origin: "app" });
  core.setStep(runId, "review", jobId, "done", { preview: dryRun ? "approved (dry run)" : "approved" });
  core.setStep(runId, "apply", jobId, "running", { preview: dryRun ? "dry run queued" : "queued" });
  const task = core.startTask(runId, core.findStep(runId, "apply", jobId)?.id ?? null, "apply", "submit", { applicationId: app.id, jobId, cvVersionId: option.cvVersion.id, introText: input.introText, dryRun });
  const ctx: ApplyCtx = { runId, jobId, company: card.job.company, host, app, task, dryRun };
  applyCtx.set(task, ctx);
  core.background(
    core
      .post(LEAD_ROOM_ID, LEAD, `${dryRun ? "Dry run approved" : "Approval token created"} for **${card.job.company}**. Apply is filling the form in your Chrome (tab group “Apply”)${dryRun ? " and will stop before submit" : ""}.`, { runIds: [runId] })
      .then(() => fillForm(core, ctx)),
  );
  return { applicationId: app.id, taskId: task.id, approval: { expiresAt: new Date(core.nowMs() + 24 * 3600_000).toISOString(), allowedDomains: [host] }, reapproval: false };
}

async function fillForm(core: Core, ctx: ApplyCtx): Promise<void> {
  const { task } = ctx;
  for (const [kind, text, tool] of [
    ["tool_use", `Opening ${ctx.host}`, "mcp__claude-in-chrome__navigate"],
    ["tool_use", "Filling name, email and phone from your master CV", "mcp__claude-in-chrome__form_input"],
    ["tool_use", "Uploading the approved PDF", "mcp__claude-in-chrome__file_upload"],
  ] as Line[]) {
    await core.wait(450);
    core.progress(task, kind, text, tool ?? null);
  }
  const saved = new Set(core.state.savedAnswers.map((a) => a.key));
  const questions = (core.state.forms[ctx.jobId] ?? []).filter((q) => !saved.has(normalizeAnswerKey(q.label)));
  if (questions.length === 0) return submit(core, ctx);
  const reason: PauseReason = { code: "needs_answer", site: null, detail: "Fields with no saved answer" };
  task.status = "paused";
  task.pauseReason = reason;
  core.emit({ type: "task.paused", taskId: task.id, runId: ctx.runId, botName: "apply", reason });
  core.setBotActivity("apply", "paused");
  moveApplication(core, ctx.app, "paused", "waiting for your answer");
  core.setStep(ctx.runId, "apply", ctx.jobId, "paused", { preview: "waiting for your answer" });
  const pause: MockPause = { taskId: task.id, runId: ctx.runId, botName: "apply", reason, applicationId: ctx.app.id, jobId: ctx.jobId, questions };
  core.state.pauses[task.id] = pause;
  await postQuestion(core, pause, ctx.company);
}

async function postQuestion(core: Core, pause: MockPause, company: string): Promise<void> {
  const q = pause.questions[0]!;
  const card: MessageCard = { type: "question", applicationId: pause.applicationId ?? "", taskId: pause.taskId, question: q, answered: false };
  await core.post(LEAD_ROOM_ID, LEAD, `❓ ${company}'s form has ${q.required ? "a **required**" : "an **optional**"} field I have no saved answer for:`, { cards: [card] });
}

export async function afterAnswer(core: Core, pause: MockPause): Promise<void> {
  const ctx = [...Object.values(core.state.runs).flatMap((r) => r.tasks)].map((t) => applyCtx.get(t)).find((c) => c?.task.id === pause.taskId);
  if (!ctx) return;
  if (pause.questions.length > 0) {
    await core.wait(400);
    return postQuestion(core, pause, ctx.company);
  }
  delete core.state.pauses[pause.taskId];
  ctx.task.status = "running";
  ctx.task.pauseReason = null;
  core.emit({ type: "task.resumed", taskId: ctx.task.id, runId: ctx.runId, botName: "apply" });
  core.setBotActivity("apply", "working");
  moveApplication(core, ctx.app, "approved", "answers complete");
  core.setStep(ctx.runId, "apply", ctx.jobId, "running", { preview: "answers complete; resuming" });
  return submit(core, ctx);
}

async function submit(core: Core, ctx: ApplyCtx): Promise<void> {
  const { task } = ctx;
  await core.wait(500);
  core.progress(task, "tool_use", "Ticking the personal-data consent box", "mcp__claude-in-chrome__computer");
  await core.wait(500);
  core.progress(task, "status", ctx.dryRun ? "Dry run: stopped before submit; screenshots taken" : "Submitted; confirmation captured");
  core.finishTask(task, "done", { status: ctx.dryRun ? "needs_check" : "submitted", selfCheck: selfCheckFor("apply", "submit"), memoryNotes: [] });
  if (ctx.dryRun) {
    moveApplication(core, ctx.app, "needs_check", "dry run");
    core.setStep(ctx.runId, "apply", ctx.jobId, "done", { preview: "dry run · needs check" });
    core.setStep(ctx.runId, "record", ctx.jobId, "done", { preview: "recorded (dry run)" });
    await core.post(LEAD_ROOM_ID, LEAD, `🧪 Dry run for **${ctx.company}** finished: the form was filled and screenshotted, nothing was submitted. Check it in Applications.`, { runIds: [ctx.runId] });
  } else {
    moveApplication(core, ctx.app, "submitted");
    core.setStep(ctx.runId, "apply", ctx.jobId, "done", { preview: "submitted" });
    core.setStep(ctx.runId, "record", ctx.jobId, "done", { preview: "recorded" });
    await core.post(LEAD_ROOM_ID, LEAD, `✅ **${ctx.company}** submitted. Confirmation captured and saved to Applications.`, { runIds: [ctx.runId] });
  }
  core.acted = core.acted.filter((c) => c.job.id !== ctx.jobId);
  maybeFinishRun(core, ctx.runId);
}

export function requestChanges(core: Core, card: ReviewCard, comment: string): void {
  const jobId = card.job.id;
  const runId = card.runId!;
  core.state.queue = core.state.queue.filter((c) => c.job.id !== jobId);
  core.acted = [...core.acted.filter((c) => c.job.id !== jobId), card];
  core.setStep(runId, "review", jobId, "done", { preview: "changes requested" });
  const r = core.runState(runId);
  const lane = r.lanes.find((l) => l.jobId === jobId) ?? { jobId, title: card.job.title, company: card.job.company };
  core.background(
    core
      .post(LEAD_ROOM_ID, LEAD, `Sent your note to **@CV** for ${card.job.company}: “${comment}”. QA will re-score it.`, { runIds: [runId] })
      .then(() => runLane(core, r, lane, { from: "tailor", comment }))
      .then(() => core.post(LEAD_ROOM_ID, LEAD, `${card.job.company}: the revised CV is back in your review queue.`, { cards: [{ type: "review_link", count: core.state.queue.length }], runIds: [runId] })),
  );
}

export function skip(core: Core, card: ReviewCard, decision: SkipDecision): void {
  const jobId = card.job.id;
  const runId = card.runId!;
  core.state.queue = core.state.queue.filter((c) => c.job.id !== jobId);
  card.job.status = "skipped";
  card.job.skipReason = decision.reason;
  card.job.skipNote = decision.note;
  core.setStep(runId, "review", jobId, "done", { preview: `skipped: ${decision.reason}` });
  core.setStep(runId, "apply", jobId, "skipped", { preview: "skipped" });
  maybeFinishRun(core, runId);
}

// ---------------------------------------------------------------- run control (UC-23)

/** UC-23 cancel; returns the tasks that got the abort signal. */
export function cancelRun(core: Core, r: RunState): string[] {
  const runId = r.run.id;
  r.run.status = "cancelled";
  const aborted = r.tasks.filter((t) => t.status === "running" || t.status === "paused").map((t) => t.id);
  for (const task of r.tasks) if (aborted.includes(task.id)) core.finishTask(task, "failed", null, "cancelled by Ba");
  for (const step of r.steps) {
    if (!["done", "failed", "skipped", "cancelled"].includes(step.status)) core.setStep(runId, step.stepKey, step.branchKey, "cancelled", { preview: "cancelled" });
  }
  core.state.queue = core.state.queue.filter((c) => c.runId !== runId);
  for (const [id, p] of Object.entries(core.state.pauses)) if (p.runId === runId) delete core.state.pauses[id];
  r.run.finishedAt = core.nowIso();
  core.emit({ type: "run.finished", runId, status: "cancelled", summary: "cancelled by Ba" });
  return aborted;
}

export async function rerun(core: Core, r: RunState, step: { stepKey: string; branchKey: string | null; preview: string | null }): Promise<void> {
  const runId = r.run.id;
  if (step.branchKey) {
    const jobId = step.branchKey.split(":")[0]!;
    const card = core.state.queue.find((c) => c.job.id === jobId);
    if (card) {
      core.state.queue = core.state.queue.filter((c) => c.job.id !== jobId);
      core.acted = [...core.acted.filter((c) => c.job.id !== jobId), card];
    }
    const from = step.stepKey === "company" ? "company" : "tailor";
    for (const s of r.steps.filter((x) => x.branchKey?.split(":")[0] === jobId && (from === "company" || x.stepKey !== "company"))) {
      if (s.stepKey !== "apply") core.setStep(runId, s.stepKey, s.branchKey, "pending", { preview: "re-run" });
    }
    if (r.run.status === "waiting") {
      r.run.status = "running";
      core.emit({ type: "run.updated", runId, status: "running" });
    }
    const lane = r.lanes.find((l) => l.jobId === jobId) ?? { jobId, title: card?.job.title ?? "", company: card?.job.company ?? "" };
    await runLane(core, r, lane, { from });
    maybeFinishRun(core, runId);
    return;
  }
  core.setStep(runId, step.stepKey, null, "running", { preview: "re-run" });
  await core.wait(800);
  core.setStep(runId, step.stepKey, null, "done", { preview: step.preview });
}

// ---------------------------------------------------------------- answers, pauses and the Simulate menu

export async function afterResume(core: Core, pause: MockPause): Promise<void> {
  const task = Object.values(core.state.runs)
    .flatMap((r) => r.tasks)
    .concat(pausedTasks.get(core) ?? [])
    .find((t) => t.id === pause.taskId);
  if (!task) return;
  task.status = "running";
  task.pauseReason = null;
  core.emit({ type: "task.resumed", taskId: task.id, runId: pause.runId, botName: pause.botName });
  core.setBotActivity(pause.botName, "working");
  const ctx = applyCtx.get(task);
  if (ctx) return submit(core, ctx);
  await core.wait(900);
  core.progress(task, "text", "Picked up where it stopped");
  core.finishTask(task, "done", null);
}

const pausedTasks = new WeakMap<Core, Task[]>();

async function pauseTask(core: Core, botName: string, kind: string, reason: PauseReason, text: string, extra: Partial<MockPause> = {}): Promise<void> {
  const active = Object.values(core.state.runs).find((r) => ["running", "waiting"].includes(r.run.status));
  const runId = extra.runId !== undefined ? extra.runId : (active?.run.id ?? null);
  const task = core.startTask(runId, null, botName, kind, {});
  if (!runId) pausedTasks.set(core, [...(pausedTasks.get(core) ?? []), task]);
  task.status = "paused";
  task.pauseReason = reason;
  core.emit({ type: "task.paused", taskId: task.id, runId, botName, reason });
  core.setBotActivity(botName, "paused");
  core.state.pauses[task.id] = { taskId: task.id, runId, botName, reason, applicationId: null, jobId: null, questions: [], ...extra };
  const card: MessageCard = { type: "pause", taskId: task.id, reason: reason.site ? `${reason.code}(${reason.site})` : reason.code };
  await core.post(LEAD_ROOM_ID, LEAD, text, { cards: [card], runIds: runId ? [runId] : [] });
}

function minutesFromNow(core: Core, minutes: number): string {
  const ms = core.nowMs() + minutes * 60_000;
  return new Date(Math.ceil(ms / 60_000) * 60_000).toISOString();
}

export async function simulate(core: Core, kind: SimulationKind): Promise<void> {
  switch (kind) {
    case "scheduled-scan": {
      const r = createRun(core, "job-scan", "schedule", { searchProfileId: null, overrides: null }, "sch_1");
      core.emit({ type: "schedule.fired", scheduleId: "sch_1", runId: r.run.id, catchUp: false });
      await core.post(LEAD_ROOM_ID, LEAD, "Scheduled scan started: Weekday morning scan.", { cards: [{ type: "run", runId: r.run.id }], runIds: [r.run.id] });
      return jobScan(core, r);
    }
    case "claude-limit":
    case "codex-limit": {
      const engine = kind === "claude-limit" ? "claude" : "codex";
      const label = engine === "claude" ? "Claude" : "ChatGPT";
      const until = minutesFromNow(core, 130);
      const status = core.state.engines.find((e) => e.engine === engine)!;
      status.pausedUntil = until;
      status.reason = "usage_limit";
      core.emit({ type: "engine.paused", engine, until, reason: "usage_limit" });
      await core.post(LEAD_ROOM_ID, LEAD, `⏸ ${label} usage limit reached. Tasks on ${label} wait for the reset and then **continue automatically**.`);
      return;
    }
    case "limits-reset": {
      for (const e of core.state.engines.filter((x) => x.pausedUntil)) {
        e.pausedUntil = null;
        e.reason = null;
        core.emit({ type: "engine.resumed", engine: e.engine });
        await core.post(LEAD_ROOM_ID, LEAD, `✅ ${e.engine === "claude" ? "Claude" : "ChatGPT"} usage limit has reset — **resumed automatically**. No action needed.`);
      }
      return;
    }
    case "chrome-toggle": {
      core.state.chromeConnected = !core.state.chromeConnected;
      core.emit({ type: "bridge.status", bridge: "chrome", engine: null, connected: core.state.chromeConnected });
      await core.post(
        LEAD_ROOM_ID,
        LEAD,
        core.state.chromeConnected
          ? "🌐 Chrome reconnected — browser steps resumed."
          : "🌐 Chrome is closed — browser steps are waiting (needs_browser). They start as soon as Chrome reconnects.",
      );
      return;
    }
    case "login-expired":
      return pauseTask(core, "research", "scan", { code: "needs_login", site: "linkedin.com", detail: "LinkedIn shows the sign-in wall" }, "Research paused the LinkedIn scan: the LinkedIn session has expired.");
    case "captcha":
      return pauseTask(core, "research", "scan", { code: "captcha", site: "topcv.vn", detail: null }, "Research paused the TopCV scan: TopCV is showing a CAPTCHA.");
    case "figma":
      return pauseTask(core, "cv", "tailor", { code: "needs_figma", site: null, detail: null }, "CV is waiting for Figma.");
    case "domain-confirm": {
      const card = core.state.queue[0];
      return pauseTask(
        core,
        "apply",
        "submit",
        { code: "domain_confirm", site: "acme.wd3.myworkdayjobs.com", detail: "The apply button opened another site" },
        `Apply paused on ${card?.job.company ?? "an application"}: the form moved to another site.`,
        { jobId: card?.job.id ?? null },
      );
    }
  }
}
