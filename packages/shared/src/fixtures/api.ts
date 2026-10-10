// API view fixtures.
import type { ReviewCard } from "../api/review.js";
import { cvOutputFixture, qaPassFixture, researchCompanyFixture } from "./bot-outputs.js";
import { jobFixture } from "./domain.js";

export const reviewCardFixture: ReviewCard = {
  job: jobFixture,
  company: {
    id: "co_novapay",
    name: "NovaPay",
    website: "https://novapay.example.com",
    profile: researchCompanyFixture.company,
    confidence: "normal",
    researchedAt: "2026-10-10T09:12:00+07:00",
  },
  runId: "run_13",
  cvOptions: [
    {
      cvVersion: {
        id: "cvv_2",
        jobId: "job_1",
        language: "en",
        round: 1,
        tailored: cvOutputFixture.tailored,
        figmaFrameName: cvOutputFixture.figmaFrameName,
        figmaFrameUrl: cvOutputFixture.figmaFrameUrl,
        pdfPath: "data/pdf/NOVAPAY_SENIOR-FRONTEND_EN_v1.pdf",
        pdfSha256: "6618f61f79198cbad7d0e3f7255575840b40d317878fab7393a1b7b6ffc589ec",
        changeNotes: cvOutputFixture.changeNotes,
        factRequests: cvOutputFixture.factRequests,
        masterVersion: 3,
        promptVersion: 4,
        createdAt: "2026-10-10T09:30:00+07:00",
      },
      qaRounds: [
        {
          id: "qa_1",
          cvVersionId: "cvv_2",
          total: qaPassFixture.total,
          scores: qaPassFixture.scores,
          hardFails: [],
          fixes: qaPassFixture.fixes,
          injectionSuspected: false,
          passed: true,
          createdAt: "2026-10-10T09:34:00+07:00",
        },
      ],
      pdf: { id: "file_pdf_1", kind: "cv_pdf", filename: "BA_HUYNH_NovaPay_EN_v1.pdf", mime: "application/pdf" },
    },
  ],
  defaultLanguage: "en",
  introText: "I have 4+ years building React/Next.js products and owned internal apps used by ~300 employees.",
  factRequests: cvOutputFixture.factRequests,
  flags: {
    qaPassed: true,
    escalated: false,
    needsInput: false,
    injectionFlagged: false,
    masterChanged: false,
    noApplyLink: false,
    lowConfidenceCompany: false,
  },
  readyAt: "2026-10-10T09:35:00+07:00",
};
