// Seed helpers for data-layer tests (and for other workers' integration tests).
import type { Conn } from "./client.js";
import { upsertBot } from "./repos/bots.js";
import { createRun, createStep } from "./repos/runs.js";
import { createTask, type CreateTaskInput } from "./repos/tasks.js";
import { upsertJobCandidate, type JobCandidateInput } from "./repos/jobs.js";
import { createCvVersion } from "./repos/cv.js";
import type { Job, Run, Step, Task, CvVersion } from "./types.js";

export const T0 = new Date("2026-10-10T08:00:00.000Z");

/** `T0 + seconds`. */
export function at(seconds: number): Date {
  return new Date(T0.getTime() + seconds * 1000);
}

/** The five Phase 1 bots (§5.2). */
export function seedBots(db: Conn): void {
  upsertBot(db, { name: "lead", displayName: "Lead", engine: "claude", trustLevel: 1 });
  upsertBot(db, { name: "research", displayName: "Research", engine: "codex", trustLevel: 2 });
  upsertBot(db, { name: "cv", displayName: "CV", engine: "claude", trustLevel: 2 });
  upsertBot(db, { name: "qa", displayName: "QA", engine: "codex", trustLevel: 2 });
  upsertBot(db, { name: "apply", displayName: "Apply", engine: "claude", trustLevel: 1 });
}

export function seedRun(db: Conn, now: Date = T0): { run: Run; step: Step } {
  const run = createRun(
    db,
    { workflowName: "job-scan", workflowVersion: 1, trigger: "chat", params: { maxJobs: 5 } },
    { now },
  );
  const step = createStep(db, { runId: run.id, stepKey: "scan" });
  return { run, step };
}

export function seedTask(
  db: Conn,
  ctx: { run: Run; step: Step },
  overrides: Partial<CreateTaskInput> = {},
  now: Date = T0,
): Task {
  return createTask(
    db,
    {
      runId: ctx.run.id,
      stepId: ctx.step.id,
      botName: "research",
      kind: "scan",
      engine: "codex",
      input: { source: "TopCV" },
      ...overrides,
    },
    { now },
  );
}

export const NOVAPAY: JobCandidateInput = {
  source: "ITviec",
  url: "https://itviec.com/it-jobs/senior-frontend-engineer-react-nextjs-novapay-1234?utm_source=feed&lab_feature=x",
  title: "Senior Frontend Engineer (React/Next.js)",
  company: "NovaPay",
  location: "Ho Chi Minh City",
  salaryText: "2,000–2,800 USD",
  language: "EN",
  jdText: "We are looking for a Senior Frontend Engineer…",
};

export function seedJob(db: Conn, candidate: JobCandidateInput = NOVAPAY, now: Date = T0): Job {
  return upsertJobCandidate(db, candidate, { now }).job;
}

export function seedCv(db: Conn, job: Job, now: Date = T0): CvVersion {
  return createCvVersion(
    db,
    {
      jobId: job.id,
      language: "EN",
      tailored: { headline: "Frontend Engineer" },
      pdfPath: "data/pdf/NOVAPAY_FE_EN_v1.pdf",
      pdfSha256: "a".repeat(64),
      figmaFrameUrl: "https://www.figma.com/design/kJFoXNrTfFOtkQ515c0jHk?node-id=1-2",
      masterVersion: 1,
      promptVersion: 1,
    },
    { now },
  );
}
