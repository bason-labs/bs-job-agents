// Task input fixtures (one per bot task kind).
import type {
  ApplySubmitInput,
  CvTailorInput,
  QaReviewInput,
  ResearchCompanyInput,
  ResearchFileInput,
  ResearchFitInput,
  ResearchScanInput,
  ResearchSingleInput,
} from "../bots/inputs.js";
import { SEARCH_PROFILE_DEFAULTS } from "../domain/search-profile.js";
import { SAMPLE_SHA256, cvOutputFixture, researchCompanyFixture, researchScanFixture } from "./bot-outputs.js";

const novapay = researchScanFixture.jobs[0]!;

export const researchScanInputFixture: ResearchScanInput = {
  source: "topcv",
  criteria: {
    ...SEARCH_PROFILE_DEFAULTS,
    workModes: [...SEARCH_PROFILE_DEFAULTS.workModes],
    seniority: [...SEARCH_PROFILE_DEFAULTS.seniority],
    sources: [...SEARCH_PROFILE_DEFAULTS.sources],
    includeKeywords: ["React", "Next.js", "TypeScript"],
    excludeKeywords: ["PHP", "WordPress"],
    excludeCompanies: [],
    companyTypes: ["product", "AI"],
    languages: ["en"],
    roles: ["Frontend Engineer", "Software Engineer (React/Node)"],
    locations: ["Ho Chi Minh City", "Remote (VN)"],
    minSalary: 25_000_000,
    currency: "VND",
  },
  maxPageViews: null,
};

export const researchSingleInputFixture: ResearchSingleInput = { url: novapay.url! };

export const researchFileInputFixture: ResearchFileInput = {
  uploadId: "upl_1",
  path: "data/uploads/upl_1/JD_NovaPay.pdf",
  filename: "JD_NovaPay.pdf",
  mime: "application/pdf",
};

export const researchFitInputFixture: ResearchFitInput = { jobId: "job_1", job: novapay, masterCvVersion: 3 };

export const researchCompanyInputFixture: ResearchCompanyInput = { name: "NovaPay", website: "https://novapay.example.com" };

export const cvTailorInputFixture: CvTailorInput = {
  jobId: "job_1",
  job: novapay,
  company: researchCompanyFixture.company,
  language: "en",
  round: 2,
  fixes: [{ section: "Summary", instruction: "Shorten to one sentence." }],
  comment: null,
  previousCvVersionId: "cvv_1",
  masterCvVersion: 3,
};

const { selfCheck: _s, memoryNotes: _m, ...draft } = cvOutputFixture;

export const qaReviewInputFixture: QaReviewInput = {
  jobId: "job_1",
  cvVersionId: "cvv_2",
  job: novapay,
  company: researchCompanyFixture.company,
  draft: { ...draft, pdfPath: "data/pdf/NOVAPAY_SENIOR-FRONTEND_EN_v1.pdf" },
  pdfText: "Ba Huynh\nSoftware Engineer — React / Next.js / Node.js\n…",
  pdf: {
    pageCount: 1,
    onePageA4: true,
    widthPt: 595.28,
    heightPt: 841.89,
    sha256: "a".repeat(64),
    textChars: 52,
  },
  masterCvVersion: 3,
};

export const applyInputFixture: ApplySubmitInput = {
  applicationId: "app_1",
  jobId: "job_1",
  cvVersionId: "cvv_2",
  jobUrl: novapay.url!,
  expectedCompany: "NovaPay",
  expectedTitle: novapay.title,
  approvalToken: "tok_7f3a",
  allowedDomains: ["itviec.com"],
  pdfPath: "data/pdf/NOVAPAY_SENIOR-FRONTEND_EN_v1.pdf",
  pdfSha256: SAMPLE_SHA256,
  introText: "I have 4+ years building React/Next.js products.",
  savedAnswers: [{ key: "notice period", label: "Notice period", answer: "2 weeks" }],
  answers: [],
  formDefaults: { salaryPolicy: "blank_if_optional", salaryAmount: null, currency: null },
  dryRun: false,
};
