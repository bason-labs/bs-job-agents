// Review cards (§11 Review queue, UC-07/08/09/10) from the engine's human steps: a card is a per-job
// review step that waits for Ba, or one whose Apply was stopped before it ran and waits for Ba to
// approve again (PM M2). The data comes from the step output (W2a HumanStepOutput), the CV versions
// and their QA rounds, the job and its company.
import {
  ReviewCardSchema,
  findOnlySourceOf,
  isApplyBlockedByInjection,
  type FactRequest,
  type HumanStepSchema,
  type ActionStepSchema,
  type ReviewCard,
} from "@bs-job-agents/shared";
import type { z } from "zod";
import {
  getApplication,
  getCompany,
  getCvVersion,
  getJob,
  listActiveRuns,
  listApplications,
  listCvVersions,
  listRuns,
  listEvents,
  listQaReviews,
  listSteps,
  mappers,
  type Db,
  type Step,
} from "../../db/index.js";
import type { ActionStepOutput, HumanStepOutput, WorkflowSource } from "../../engine/index.js";
import { isDryRunSettled } from "../../engine/review.js";
import { canApproveAgain } from "../../engine/workflow.js";
import { fileRef } from "../files.js";
import { keepValid } from "../http.js";
import { readMasterCvVersion } from "../master-cv.js";

type HumanStep = z.infer<typeof HumanStepSchema>;
type ActionStep = z.infer<typeof ActionStepSchema>;

interface Candidate {
  runId: number;
  human: Step;
  action: Step | undefined;
  approveAgain: boolean;
  /** PM2 S15: the card's dry run settled; Approve now applies live with the same CV. */
  dryRunSettled: boolean;
  /** PM3 S2: the run says "apply again" (§10.2 rule 5). */
  applyAgain: boolean;
}

/**
 * Waiting review steps of active runs, denied-before-spawn Apply steps Ba can approve again, and
 * cards whose dry run settled (their run may have finished; a live approval reopens it, PM2 S15).
 */
function candidates(db: Db, workflows: WorkflowSource): Candidate[] {
  const out: Candidate[] = [];
  for (const run of [...listActiveRuns(db), ...listRuns(db, { status: ["done", "failed"] })]) {
    const def = workflows.get(run.workflowName, run.workflowVersion);
    if (!def) continue;
    const steps = listSteps(db, run.id);
    for (const humanDef of def.steps.filter((s): s is HumanStep => s.type === "human")) {
      const actionDef = def.steps.find((s): s is ActionStep => s.type === "action" && s.approvalFrom === humanDef.key);
      for (const human of steps.filter((s) => s.stepKey === humanDef.key && s.branchKey !== "")) {
        const action = actionDef ? steps.find((s) => s.stepKey === actionDef.key && s.branchKey === human.branchKey) : undefined;
        const actionOut = action?.output as ActionStepOutput | null | undefined;
        const approveAgain =
          human.status === "done" &&
          action?.status === "locked" &&
          (actionOut?.outcome === "denied" || actionOut?.outcome === "not_started") &&
          actionOut.applicationId !== null &&
          canApproveAgain(db, actionOut.applicationId);
        const dryRunSettled =
          !approveAgain &&
          isDryRunSettled(db, { humanStatus: human.status, actionOut, jobId: Number(human.branchKey), applyAgain: run.params.applyAgain === true });
        if (human.status === "waiting" || approveAgain || dryRunSettled) {
          out.push({ runId: run.id, human, action, approveAgain, dryRunSettled, applyAgain: run.params.applyAgain === true });
        }
      }
    }
  }
  return out;
}

/**
 * PM3 S2: on an "apply again" card, the latest real application to the same job other than the
 * card's own (a re-approval keeps its own application): what Ba sees before approving a second one.
 */
function appliedBefore(db: Db, c: Candidate, jobId: number): ReviewCard["flags"]["appliedBefore"] {
  if (!c.applyAgain) return null;
  const own = (c.action?.output as ActionStepOutput | null | undefined)?.applicationId ?? null;
  const earlier = listApplications(db, { dryRun: false })
    .filter((a) => a.jobId === jobId && a.id !== own)
    .sort((a, b) => b.id - a.id)[0];
  if (!earlier) return null;
  return { applicationId: String(earlier.id), at: earlier.submittedAt ?? earlier.createdAt, status: earlier.status, origin: earlier.origin };
}

async function buildCard(db: Db, dataDir: string, c: Candidate, readyAt: Map<number, string>, masterVersion: number | null, now: Date): Promise<ReviewCard | null> {
  const out = c.human.output as HumanStepOutput | null;
  if (!out || !Array.isArray(out.cvVersions)) return null;
  const job = getJob(db, out.jobId);
  if (!job) return null;
  const company = getCompany(db, job.companyId);
  let options = out.cvVersions;
  let defaultLanguage = out.defaultLanguage;
  if (c.approveAgain || c.dryRunSettled) {
    // A re-approval, or a live approval after a dry run, keeps that CV version (the engine refuses another).
    const app = getApplication(db, (c.action!.output as ActionStepOutput).applicationId!);
    options = options.filter((o) => o.cvVersionId === app?.cvVersionId);
    defaultLanguage = options[0]?.language ?? defaultLanguage;
  }
  const allVersions = listCvVersions(db, job.id);
  const cvOptions = [];
  const factRequests: FactRequest[] = [];
  for (const option of options) {
    const row = getCvVersion(db, option.cvVersionId);
    if (!row) continue;
    const cvVersion = mappers.toCvVersion(row);
    factRequests.push(...cvVersion.factRequests);
    const qaRounds = allVersions
      .filter((v) => v.language === option.language)
      .flatMap((v) => listQaReviews(db, v.id))
      .sort((a, b) => a.id - b.id)
      .map(mappers.toQaReview);
    cvOptions.push({ cvVersion, qaRounds, pdf: await fileRef(db, dataDir, { type: "cv", id: row.id }) });
  }
  return {
    job: mappers.toJob(job, { name: company?.name ?? "" }),
    company: company ? mappers.toCompany(company) : null,
    runId: String(c.runId),
    cvOptions,
    defaultLanguage,
    // No bot drafts the intro: empty means Apply writes one from the master CV (PM FYI e).
    introText: null,
    factRequests: uniqueFactRequests(factRequests),
    flags: {
      qaPassed: out.qaPassed,
      escalated: out.escalated,
      needsInput: out.needsInput,
      injectionFlagged: isApplyBlockedByInjection(job),
      masterChanged: masterVersion !== null && cvOptions.some((o) => o.cvVersion.masterVersion < masterVersion),
      noApplyLink: job.url === null,
      lowConfidenceCompany: company?.confidence === "low_confidence",
      approveAgain: c.approveAgain,
      companyMissing: out.companyMissing === true,
      dryRunSettled: c.dryRunSettled,
      appliedBefore: appliedBefore(db, c, job.id),
      // W5: Upwork is find only: Approve is refused; the card links to the posting instead.
      findOnly: findOnlySourceOf(job) !== null,
    },
    readyAt: readyAt.get(job.id) ?? now.toISOString(),
  };
}

/** The review queue, newest card first. A card that cannot be built or does not validate is left out. */
export async function reviewQueue(
  db: Db,
  opts: { dataDir: string; workflows: WorkflowSource; now: Date; warn: (m: string) => void },
): Promise<ReviewCard[]> {
  const readyAt = new Map<number, string>();
  for (const row of listEvents(db, { types: ["review.ready"] })) {
    const jobId = Number((row.payload as { jobId?: unknown }).jobId);
    if (Number.isInteger(jobId)) readyAt.set(jobId, row.createdAt);
  }
  const masterVersion = readMasterCvVersion(opts.dataDir);
  const cards: unknown[] = [];
  const seen = new Set<string>();
  for (const c of candidates(db, opts.workflows)) {
    const card = await buildCard(db, opts.dataDir, c, readyAt, masterVersion, opts.now);
    if (!card || seen.has(card.job.id)) continue;
    seen.add(card.job.id);
    cards.push(card);
  }
  return keepValid(ReviewCardSchema, cards, opts.warn).sort((a, b) => b.readyAt.localeCompare(a.readyAt));
}

/** VI and EN versions of one job often ask Ba the same thing; the card lists each topic once. */
export function uniqueFactRequests(requests: FactRequest[]): FactRequest[] {
  const seen = new Set<string>();
  return requests.filter((r) => {
    const key = r.topic.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
