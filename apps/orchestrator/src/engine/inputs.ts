// Task inputs (§5.5 step 1). A workflow's template values say what a task is about ("$item",
// "$params.url"); the builders add what the database knows (the job, its company profile, the CV
// version, the master CV version) and validate the result with BOT_TASK_INPUT_SCHEMAS.
// apply.submit is not built here: its input is assembled at spawn (apply.ts), without the token.
import {
  BOT_TASK_INPUT_SCHEMAS,
  CompanyProfileSchema,
  IsoDateTimeSchema,
  JobCandidateSchema,
  LIMITS,
  UrlSchema,
  cvLanguagesForJd,
  taskKey,
  type BotTaskKey,
  type CompanyProfile,
  type CvDeriveInput,
  type CvDraft,
  type CvLanguage,
  type CvReviewInput,
  type GuidanceRuleInput,
  type JobCandidate,
  type QaFix,
  type VerifiedPdfFacts,
} from "@bs-job-agents/shared";
import { SOURCE_ADAPTERS, scanJobLimit } from "../adapters/index.js";
import { isAdapterSource } from "../adapters/sources.js";
import { getCompany, getCvVersion, getJob, getUpload, upsertJobCandidate, type Company, type Conn, type CvVersion, type Job } from "../db/index.js";
import type { RunCtx, Scope } from "./context.js";
import { invalidInput } from "./errors.js";
import type { JobRef } from "./state.js";

export interface GateInputs {
  language: CvLanguage;
  round: number;
  fixes: QaFix[];
  comment: string | null;
  previousCvVersionId: number | null;
  /** CV guidance (§5.7): the applied positions tailor follows, as data. */
  guidance?: GuidanceRuleInput[];
}

/** cv.review in a gate (§5.7): what the gate knows of the round; the job and CV come from the database. */
export interface ReviewInputs {
  cvVersionId: number;
  pdfText: string;
  facts: CvReviewInput["facts"];
  rules: GuidanceRuleInput[];
}

export interface InputRequest {
  conn: Conn;
  ctx: RunCtx | null;
  now: Date;
  botName: string;
  kind: string;
  /** The step's `input` with its templates resolved. */
  resolved: Record<string, unknown>;
  /** The map item or the branch's job. */
  item?: unknown;
  scope?: Scope;
  /** cv.tailor in a gate. */
  gate?: GateInputs;
  /** qa.review in a gate. */
  checker?: { cvVersionId: number; pdfText: string; pdf?: VerifiedPdfFacts };
  /** cv.derive: built by the derive step from the job's gaps and the master CV (derive.ts). */
  derive?: CvDeriveInput;
  /** cv.review in a gate (CV guidance §5.7). */
  review?: ReviewInputs;
  /** research.guidance_extract / guidance_discover: built by the guidance step (guidance-refresh.ts). */
  prebuilt?: unknown;
}

export interface BuiltInput {
  input: unknown;
  /** The job the task is about, when there is one (map items keep it). */
  jobId?: number;
}

const validUrl = (value: unknown): string | null => (UrlSchema.safeParse(value).success ? (value as string) : null);

/** A stored job as the bots see it (shared JobCandidate). */
export function toJobCandidate(job: Job, company: Pick<Company, "name" | "website"> | undefined): JobCandidate {
  return {
    source: job.source,
    url: validUrl(job.url),
    title: job.title,
    company: company?.name ?? "unknown",
    companyWebsite: validUrl(company?.website),
    location: job.location || "unknown",
    workMode: job.workMode,
    salaryText: job.salaryText,
    postedAt: IsoDateTimeSchema.safeParse(job.postedAt).success ? job.postedAt : null,
    language: job.language && /^[a-z]{2}$/.test(job.language) ? job.language : "en",
    jdText: job.jdText || job.title,
  };
}

export function companyProfileOf(company: Company | undefined): CompanyProfile | null {
  const parsed = CompanyProfileSchema.safeParse(company?.profile);
  return parsed.success ? parsed.data : null;
}

export function cvDraftOf(cv: CvVersion): CvDraft {
  return {
    language: cv.language,
    tailored: cv.tailored as CvDraft["tailored"],
    figmaFrameName: cv.figmaFrameName ?? "",
    figmaFrameUrl: cv.figmaFrameUrl ?? "",
    pdfPath: cv.pdfPath,
    changeNotes: cv.changeNotes,
    // CV's own questions only, in the bot's shape (guidance requests are stored beside them, §5.8).
    factRequests: cv.factRequests.filter((r) => r.origin !== "guidance").map(({ topic, question, reason }) => ({ topic, question, reason })),
  };
}

function jobIdOf(item: unknown): number | null {
  const id = (item as Partial<JobRef> | null | undefined)?.jobId;
  return typeof id === "number" && Number.isInteger(id) ? id : null;
}

function requireJob(conn: Conn, id: number | null): Job {
  const job = id === null ? undefined : getJob(conn, id);
  if (!job) throw invalidInput(`job ${id ?? "(none)"} not found`);
  return job;
}

function masterVersion(ctx: RunCtx | null): number {
  const v = ctx?.masterVersion;
  if (v === null || v === undefined) throw invalidInput("the master CV is missing (UC-01 c): add it on the Master CV screen");
  return v;
}

function validate(key: string, input: unknown): unknown {
  if (!Object.hasOwn(BOT_TASK_INPUT_SCHEMAS, key)) return input;
  const parsed = BOT_TASK_INPUT_SCHEMAS[key as BotTaskKey].safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw invalidInput(`${key} input is invalid: ${issues.join("; ")}`, parsed.error.issues);
  }
  return parsed.data;
}

export function buildTaskInput(req: InputRequest): BuiltInput {
  const key = taskKey(req.botName, req.kind);
  const { conn, ctx, resolved } = req;
  switch (key) {
    case "research.scan": {
      if (!ctx?.profile) throw invalidInput("a scan needs a search profile (UC-21b)");
      const source = resolved.source ?? req.item;
      return {
        input: validate(key, {
          source,
          criteria: ctx.profile,
          // UC-03 c (LinkedIn) and W5 (Wellfound, Upwork: Ba's own login): the page-view cap per scan.
          maxPageViews: source === "linkedin" ? LIMITS.linkedinMaxPageViews : typeof source === "string" && isAdapterSource(source) ? SOURCE_ADAPTERS[source].maxPageViews : null,
          candidateLimit: scanJobLimit(ctx.profile.maxJobs),
        }),
      };
    }
    case "research.single":
      return { input: validate(key, { url: resolved.url ?? ctx?.params.url }) };
    case "research.file": {
      const uploadId = Number(resolved.uploadId ?? ctx?.params.uploadId);
      const upload = Number.isInteger(uploadId) ? getUpload(conn, uploadId) : undefined;
      if (!upload) throw invalidInput(`upload ${String(resolved.uploadId ?? ctx?.params.uploadId)} not found`);
      return {
        input: validate(key, { uploadId: String(upload.id), path: upload.path, filename: upload.filename, mime: upload.mime }),
      };
    }
    case "research.fit": {
      let job: Job;
      const id = jobIdOf(req.item);
      if (id !== null) job = requireJob(conn, id);
      else {
        // apply-to-link / apply-to-file: the item is the scanned JobCandidate; store it (or find it).
        const candidate = JobCandidateSchema.safeParse(req.item);
        if (!candidate.success) throw invalidInput("research.fit needs a job or a JobCandidate");
        job = upsertJobCandidate(conn, candidate.data, { now: req.now }).job;
      }
      const company = getCompany(conn, job.companyId);
      return {
        input: validate(key, { jobId: String(job.id), job: toJobCandidate(job, company), masterCvVersion: masterVersion(ctx) }),
        jobId: job.id,
      };
    }
    case "research.company": {
      const job = requireJob(conn, jobIdOf(req.scope?.item ?? req.item));
      const company = getCompany(conn, job.companyId);
      if (!company) throw invalidInput(`company of job ${job.id} not found`);
      return { input: validate(key, { name: company.name, website: validUrl(company.website) }), jobId: job.id };
    }
    case "cv.tailor": {
      const gate = req.gate;
      if (!gate) throw invalidInput("cv.tailor runs inside a QA gate");
      const job = requireJob(conn, jobIdOf(req.scope?.item ?? req.item));
      const company = getCompany(conn, job.companyId);
      return {
        input: validate(key, {
          jobId: String(job.id),
          job: toJobCandidate(job, company),
          company: companyProfileOf(company),
          language: gate.language,
          round: gate.round,
          fixes: gate.fixes,
          comment: gate.comment,
          previousCvVersionId: gate.previousCvVersionId === null ? null : String(gate.previousCvVersionId),
          masterCvVersion: masterVersion(ctx),
          ...(gate.guidance && gate.guidance.length > 0 ? { guidance: gate.guidance } : {}),
        }),
        jobId: job.id,
      };
    }
    case "qa.review": {
      const checker = req.checker;
      if (!checker) throw invalidInput("qa.review runs inside a QA gate");
      const cv = getCvVersion(conn, checker.cvVersionId);
      if (!cv) throw invalidInput(`CV version ${checker.cvVersionId} not found`);
      const job = requireJob(conn, cv.jobId);
      const company = getCompany(conn, job.companyId);
      const candidate = toJobCandidate(job, company);
      return {
        input: validate(key, {
          jobId: String(job.id),
          cvVersionId: String(cv.id),
          job: candidate,
          company: companyProfileOf(company),
          draft: cvDraftOf(cv),
          pdfText: checker.pdfText,
          ...(checker.pdf ? { pdf: checker.pdf } : {}),
          // Live run 1 (F6): QA checks the version's own target language, trusted, never the JD's (§6.3).
          cvLanguage: cv.language,
          expectedLanguages: cvLanguagesForJd(candidate.language),
          masterCvVersion: masterVersion(ctx),
        }),
        jobId: job.id,
      };
    }
    case "cv.review": {
      const review = req.review;
      if (!review) throw invalidInput("cv.review runs inside a QA gate, which builds its input");
      const cv = getCvVersion(conn, review.cvVersionId);
      if (!cv) throw invalidInput(`CV version ${review.cvVersionId} not found`);
      const job = requireJob(conn, cv.jobId);
      return {
        input: validate(key, {
          jobId: String(job.id),
          cvVersionId: String(cv.id),
          language: cv.language,
          job: toJobCandidate(job, getCompany(conn, job.companyId)),
          draft: cvDraftOf(cv),
          pdfText: review.pdfText,
          facts: review.facts,
          rules: review.rules,
        }),
        jobId: job.id,
      };
    }
    case "research.guidance_extract":
    case "research.guidance_discover":
      if (req.prebuilt === undefined) throw invalidInput(`${key} runs in the guidance step, which builds its input`);
      return { input: validate(key, req.prebuilt) };
    case "cv.derive": {
      if (!req.derive) throw invalidInput("cv.derive runs in the derive step, which builds its input");
      return { input: validate(key, req.derive), jobId: Number(req.derive.jobId) };
    }
    default:
      // Bots added later: the resolved template input as is, validated when a schema exists.
      return { input: validate(key, resolved) };
  }
}
