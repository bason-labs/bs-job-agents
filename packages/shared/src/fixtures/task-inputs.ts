// Task input fixtures (one per bot task kind).
import type {
  ApplySubmitInput,
  CvDeriveInput,
  CvFactDraftInput,
  CvReviewInput,
  GuidanceDiscoverInput,
  GuidanceExtractInput,
  CvTailorInput,
  QaReviewInput,
  ResearchCompanyInput,
  ResearchFileInput,
  ResearchFitInput,
  ResearchRepairInput,
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

/** cv.fact_draft: Ba answers CV's AWS question in his own words (owner request 2026-10-11). */
export const cvFactDraftInputFixture: CvFactDraftInput = {
  text: "Yes, at Gradion I deployed our Next.js apps to AWS ECS with Terraform.",
  question: { topic: "AWS", question: "Have you deployed on AWS?", reason: "The JD asks for AWS deployments", company: "Hubble" },
  existingFacts: [
    { id: "grad-1", type: "experience", org: "Gradion", dates: "2022 – present" },
    { id: "skill-1", type: "skill", org: null, dates: null },
  ],
  masterCvVersion: 3,
};

/** cv.derive: one gap the table could not resolve, against Ba's own facts (CV auto-extend). */
export const cvDeriveInputFixture: CvDeriveInput = {
  jobId: "job_1",
  gaps: ["state management at scale"],
  requirements: ["Experience with state management at scale (Redux, Zustand or similar)."],
  facts: [
    { id: "grad-3", type: "experience", text: "Built the customer portal in React and Next.js", tags: ["react", "next.js"], org: "Gradion", dates: "2023 – 2025" },
    { id: "grad-12", type: "experience", text: "Built CI pipelines in GitHub Actions for 6 services", tags: ["ci"], org: "Gradion", dates: "2023 – 2025" },
  ],
  masterCvVersion: 14,
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
  cvLanguage: "en",
  expectedLanguages: ["en"],
  masterCvVersion: 3,
};

/** cv.review: one tailored CV against the applied judgement rules (CV guidance §5.7). */
export const cvReviewInputFixture: CvReviewInput = {
  jobId: "job_1",
  cvVersionId: "cvv_2",
  language: "en",
  job: novapay,
  draft: { ...draft, pdfPath: "data/pdf/NOVAPAY_SENIOR-FRONTEND_EN_v1.pdf" },
  pdfText: "Ba Huynh\nSoftware Engineer — React / Next.js / Node.js\n…",
  facts: [{ id: "grad-1", type: "experience", text: "Owned a React/Node.js app used by about 300 employees", textVi: null, tags: ["react"], org: "Gradion", dates: "Sep 2025 – Present" }],
  rules: [{ ruleId: "order-most-relevant-first", point: "The most relevant experience comes first", text: "Lead with the experience most relevant to the role." }],
};

/** research.guidance_extract: one changed page as quoted data (CV guidance §5.4). */
export const guidanceExtractInputFixture: GuidanceExtractInput = {
  rules: [{ ruleId: "dates-month-year", topic: "dates", point: "Education and experience dates give month and year", positions: [{ positionId: "vnpt-month-year", text: "Give month and year on every date." }] }],
  pages: [{ url: "https://hr.example.com/cv-guide", title: "CV guide", text: "Open with a short summary of the experience most relevant to the role." }],
};

export const guidanceDiscoverInputFixture: GuidanceDiscoverInput = { knownHosts: ["indeed.com", "topcv.vn"], wanted: ["an ATS vendor's CV guide"], maxUrls: 10 };

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

/** research.repair: TopCV's listing lost its cards (skill self-repair §5.2). */
export const researchRepairInputFixture: ResearchRepairInput = {
  source: "topcv",
  currentSkill: "---\nname: source-topcv\ndescription: How Research scans TopCV.\n---\n\n# TopCV (topcv.vn)\n\nRead-only.\n\n## 1. Layout changed\n`Layout changed: <what is missing> on <page URL>`\n\n## 2. No results\n`No results: the page says 0 jobs`\n",
  failure: { reason: "no job cards on the results page (layout changed?)", screenshot: null },
  searchUrls: ["https://www.topcv.vn/tim-viec-lam-frontend-engineer-tai-ho-chi-minh-kl2"],
  requiredNotes: { layoutChanged: "Layout changed: <what is missing> on <page URL>", noResults: "No results: the page says 0 jobs" },
  limits: { jobLimit: 30, maxPageViews: null, delaySec: null },
  hosts: ["topcv.vn"],
};
