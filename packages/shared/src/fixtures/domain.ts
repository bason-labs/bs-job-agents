// Domain record fixtures, shaped after the Stage 0 prototype's fake data.
import type { Application, SubmissionRecord } from "../domain/application.js";
import type { ApprovalToken } from "../domain/approval.js";
import type { Message } from "../domain/chat.js";
import type { Job } from "../domain/job.js";
import type { MasterCv } from "../domain/master-cv.js";
import type { Run, Step, Task } from "../domain/run.js";
import type { Schedule } from "../domain/schedule.js";
import type { SearchProfile } from "../domain/search-profile.js";
import type { Upload } from "../domain/upload.js";
import { SAMPLE_SHA256, applyOutputFixture, researchScanFixture } from "./bot-outputs.js";

const novapay = researchScanFixture.jobs[0]!;

export const searchProfileFixture: SearchProfile = {
  id: "sp_default",
  name: "Default",
  version: 3,
  active: true,
  roles: ["Frontend Engineer", "Software Engineer (React/Node)"],
  locations: ["Ho Chi Minh City", "Remote (VN)"],
  workModes: ["onsite", "hybrid", "remote"],
  minSalary: 25_000_000,
  currency: "VND",
  seniority: ["mid", "senior"],
  sources: ["topcv", "itviec", "linkedin"],
  includeKeywords: ["React", "Next.js", "TypeScript"],
  excludeKeywords: ["PHP", "WordPress"],
  excludeCompanies: [],
  companyTypes: ["product", "AI"],
  languages: ["en"],
  maxJobs: 5,
  fitThreshold: 60,
  salaryPolicy: "blank_if_optional",
  salaryAmount: null,
  updatedAt: "2026-10-10T08:00:00+07:00",
};

export const jobFixture: Job = {
  id: "job_1",
  source: novapay.source,
  url: novapay.url,
  canonicalUrl: novapay.url,
  dedupeHash: "novapay|senior frontend engineer (react/next.js)|ho chi minh city",
  title: novapay.title,
  companyId: "co_novapay",
  company: novapay.company,
  location: novapay.location,
  workMode: novapay.workMode,
  salaryText: novapay.salaryText,
  language: novapay.language,
  jdText: novapay.jdText,
  fitScore: 87,
  fitReasons: ["React/Next.js + TypeScript ownership matches Gradion apps"],
  gaps: ["Asks for GraphQL — not in master data"],
  status: "reviewing",
  skipReason: null,
  skipNote: null,
  injectionFlagged: false,
  injectionClearedAt: null,
  firstSeenAt: "2026-10-10T09:05:00+07:00",
};

export const applicationFixture: Application = {
  id: "app_1",
  jobId: "job_1",
  cvVersionId: "cvv_2",
  submittedAt: "2026-10-10T15:40:00+07:00",
  status: "submitted",
  origin: "app",
  statusHistory: [
    { status: "approved", at: "2026-10-10T15:36:00+07:00", note: null },
    { status: "submitted", at: "2026-10-10T15:40:00+07:00", note: null },
  ],
  dryRun: false,
};

export const importedApplicationFixture: Application = {
  id: "app_dekon",
  jobId: "job_dekon",
  cvVersionId: null,
  submittedAt: "2026-10-10T15:40:00+07:00",
  status: "submitted",
  origin: "imported",
  statusHistory: [{ status: "submitted", at: "2026-10-10T15:40:00+07:00", note: "imported" }],
  dryRun: false,
};

export const submissionRecordFixture: SubmissionRecord = {
  applicationId: "app_1",
  finalUrl: applyOutputFixture.finalUrl,
  fields: applyOutputFixture.fieldsFilled.map(({ label, name, value, source }) => ({ label, name, value, source })),
  introText: applyOutputFixture.introText,
  consent: { ticked: true, text: "I agree that the employer may process my personal data for recruitment." },
  uploadedFile: {
    filename: "BA_HUYNH_NovaPay_EN_v1.pdf",
    sha256: SAMPLE_SHA256,
    path: "data/applications/app_1/BA_HUYNH_NovaPay_EN_v1.pdf",
  },
  preSubmitScreenshotPath: "data/applications/app_1/pre-submit.png",
  confirmationScreenshotPath: "data/applications/app_1/confirmation.png",
  confirmationText: "Your application has been submitted.",
  approvalToken: "tok_7f3a",
  approval: {
    approvedAt: "2026-10-10T15:36:00+07:00",
    cvVersionId: "cvv_2",
    allowedDomains: ["itviec.com"],
    note: "token for BA_HUYNH_NovaPay_EN_v1.pdf on itviec.com (single use)",
  },
  submittedAt: "2026-10-10T15:40:00+07:00",
  jdSnapshot: {
    applicationId: "app_1",
    capturedAt: "2026-10-10T15:39:00+07:00",
    url: novapay.url!,
    title: novapay.title,
    company: novapay.company,
    salaryText: novapay.salaryText,
    jdText: novapay.jdText,
    pageScreenshotPath: "data/applications/app_1/jd.png",
  },
  dryRun: false,
};

export const runFixture: Run = {
  id: "run_13",
  workflowName: "job-scan",
  workflowVersion: 1,
  trigger: "chat",
  params: { searchProfileId: null, overrides: null },
  searchProfileVersion: 3,
  scheduleId: null,
  status: "running",
  createdAt: "2026-10-10T09:00:00+07:00",
  finishedAt: null,
};

export const stepFixture: Step = {
  id: "step_7",
  runId: "run_13",
  stepKey: "tailor",
  branchKey: "job_1",
  status: "running",
  round: 2,
  output: null,
  error: null,
  startedAt: "2026-10-10T09:20:00+07:00",
  finishedAt: null,
};

export const taskFixture: Task = {
  id: "task_42",
  runId: "run_13",
  stepId: "step_7",
  botName: "cv",
  kind: "tailor",
  input: { jobId: "job_1" },
  output: null,
  status: "running",
  pauseReason: null,
  attempt: 1,
  engine: "claude",
  promptVersion: 4,
  transcriptPath: "data/transcripts/task_42.jsonl",
  error: null,
  startedAt: "2026-10-10T09:20:05+07:00",
  finishedAt: null,
};

export const scheduleFixture: Schedule = {
  id: "sch_1",
  name: "Weekday morning scan",
  cron: "0 9 * * 1-5",
  timezone: "Asia/Ho_Chi_Minh",
  workflowName: "job-scan",
  searchProfileId: null,
  params: {},
  enabled: true,
  lastRunId: "run_12",
  nextRunAt: "2026-10-13T09:00:00+07:00",
  deletedAt: null,
};

export const uploadFixture: Upload = {
  id: "upl_1",
  filename: "JD_NovaPay.pdf",
  mime: "application/pdf",
  size: 182_400,
  path: "data/uploads/upl_1/JD_NovaPay.pdf",
  sha256: SAMPLE_SHA256,
  uploadedAt: "2026-10-10T10:00:00+07:00",
  messageId: "msg_9",
};

export const approvalTokenFixture: ApprovalToken = {
  token: "tok_7f3a",
  jobId: "job_1",
  cvVersionId: "cvv_2",
  allowedDomains: ["itviec.com"],
  createdAt: "2026-10-10T15:36:00+07:00",
  expiresAt: "2026-10-11T15:36:00+07:00",
  usedAt: null,
};

export const messageFixture: Message = {
  id: "msg_10",
  roomId: "room_lead",
  author: { type: "bot", bot: "lead" },
  text: "Started Job scan #13 using search criteria v3. Delegating now.",
  mode: "work",
  mentions: [],
  runIds: ["run_13"],
  uploadIds: [],
  cards: [
    { type: "run", runId: "run_13" },
    { type: "delegation", bot: "research", task: "scan 3 sources", status: "running" },
  ],
  createdAt: "2026-10-10T09:00:01+07:00",
};

export const masterCvFixture: MasterCv = {
  version: 3,
  contact: {
    name: "Ba Huynh",
    email: "huynhthienba4@gmail.com",
    phone: "+84 37 247 4489",
    location: "Ho Chi Minh City",
    links: [],
  },
  headlineOptions: [{ en: "Software Engineer — React / Next.js / Node.js", vi: null }],
  facts: [
    {
      id: "grad-1",
      type: "experience",
      text: "Owned a React/Node.js performance review app used by ~300 employees across VN, TH, SG, DE; embedded in internal workspace.",
      textVi: null,
      tags: ["react", "node"],
      org: "Gradion",
      dates: "2022 – present",
    },
    {
      id: "skill-1",
      type: "skill",
      text: "JavaScript, TypeScript, React, Next.js, Vue/Nuxt, Angular, Node.js, PostgreSQL, Vitest, Playwright",
      textVi: null,
      tags: [],
      org: null,
      dates: null,
    },
  ],
};
