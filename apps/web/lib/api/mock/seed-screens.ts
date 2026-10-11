// Seed for the mock orchestrator's settings screens (W3c): applications, search criteria and saved
// answers, schedules, the master CV with its history and open fact requests, and Lead's workflow
// proposals. Shapes are the shared API schemas; values follow the Stage 0 prototype.
import type { FactRequestItem, SavedAnswer, ScheduleView, SearchProfile, WorkflowProposal } from "@bs-job-agents/shared";
import { cvOutputFixture, scheduleFixture, searchProfileFixture } from "@bs-job-agents/shared/fixtures";
import { MASTER_CV } from "./seed-master-cv";

/** v1 and v2 of the default profile (Ba's earlier saves), then the active v3 (the shared fixture). */
export function seedProfiles(): SearchProfile[] {
  const base = structuredClone(searchProfileFixture);
  return [
    { ...base, id: "1", version: 1, active: false, updatedAt: "2026-10-08T21:10:00+07:00", includeKeywords: ["React"], minSalary: 20_000_000 },
    { ...base, id: "2", version: 2, active: false, updatedAt: "2026-10-09T20:30:00+07:00", includeKeywords: ["React", "Next.js"] },
    { ...base, id: "3", version: 3, active: true },
  ];
}

/** UC-12 answers Apply reuses. Sao Việt Tech's start-date question is deliberately not here (the chat demo asks it). */
export function seedSavedAnswers(): SavedAnswer[] {
  return [
    { key: "notice period", label: "Notice period", answer: "2 weeks", updatedAt: "2026-10-09T19:12:00+07:00" },
    { key: "work permit", label: "Work permit", answer: "Vietnamese citizen — no work permit needed", updatedAt: "2026-10-10T15:31:00+07:00" },
  ];
}

export function seedSchedules(): ScheduleView[] {
  return [{ ...structuredClone(scheduleFixture), lastRunId: "12", nextRunAt: "2026-10-12T09:00:00+07:00", lastResult: "Fri 9 Oct · 3 to review" }];
}

export function seedMasterCvVersions(): { version: number; savedAt: string; factCount: number }[] {
  return [
    { version: 5, savedAt: "2026-10-08T22:05:00+07:00", factCount: 5 },
    { version: 6, savedAt: "2026-10-09T21:40:00+07:00", factCount: 6 },
    { version: MASTER_CV.version, savedAt: "2026-10-10T09:00:00+07:00", factCount: MASTER_CV.facts.length },
  ];
}

/** NovaPay's tailored CV (version 2102 on the review card) asked Ba for these facts (§6.1). */
export function seedFactRequests(): FactRequestItem[] {
  return cvOutputFixture.factRequests.map((r, i) => ({ id: `2102-${i}`, jobId: "101", company: "NovaPay", topic: r.topic, question: r.question, reason: r.reason }));
}

/** One suggestion from Lead, waiting for Ba (rule 3: saved only on approval, never run). */
export function seedProposals(): WorkflowProposal[] {
  return [
    {
      id: "6f1c2a52-8d0b-4c56-9a7e-2b1f0c9d4e11",
      name: "weekly-remote-react",
      description: "You asked for remote React roles three times this week. A preset of job-scan: remote only, React/Next.js, at most 5 jobs.",
      basedOn: "job-scan",
      params: { overrides: { workModes: ["remote"], includeKeywords: ["React", "Next.js"], maxJobs: 5 } },
      definitionYaml: null,
      status: "pending",
      taskId: null,
      proposedAt: "2026-10-10T20:40:00+07:00",
      decidedAt: null,
      savedVersion: null,
    },
  ];
}
