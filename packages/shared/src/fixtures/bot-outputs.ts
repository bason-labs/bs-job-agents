// Valid bot output fixtures, shaped after the Stage 0 prototype's fake data.
// Exported (via `@bs-job-agents/shared/fixtures`) for tests, the FakeRunner and UI stories.
import type { ApplyOutput } from "../bots/apply.js";
import type { ConsultOutput } from "../bots/consult.js";
import type { CvOutput } from "../bots/cv.js";
import { DERIVE_SELF_CHECK, type DeriveOutput } from "../bots/derive.js";
import { FACT_DRAFT_SELF_CHECK, type FactDraftOutput } from "../bots/fact-draft.js";
import type { LeadOutput } from "../bots/lead.js";
import type { QaOutput } from "../bots/qa.js";
import type { BotOutputSchemaName } from "../bots/registry.js";
import type { ResearchCompanyOutput, ResearchFitOutput, ResearchScanOutput } from "../bots/research.js";

export const SAMPLE_SHA256 = "6618f61f79198cbad7d0e3f7255575840b40d317878fab7393a1b7b6ffc589ec";

const pass = (item: string) => ({ item, passed: true, note: null });

export const leadOutputFixture: LeadOutput = {
  reply:
    "Started Job scan #13 using your search criteria v3. Research is scanning TopCV, ITviec and LinkedIn; I'll post review cards when they're ready.",
  actions: [
    { type: "start_workflow", workflow: "job-scan", runId: "run_13", summary: "@Research: scan 3 sources · running" },
  ],
  selfCheck: [
    pass("The request was turned into a workflow/task or a direct answer from stored data"),
    pass("No work was done directly"),
  ],
  memoryNotes: [],
};

export const leadClarifyFixture: LeadOutput = {
  reply: "Which city should I search in?",
  actions: [{ type: "ask_user", question: "Which city should I search in?", choices: ["Ho Chi Minh City", "Remote (VN)", "Đà Nẵng"] }],
  selfCheck: [pass("The request was turned into a workflow/task or a direct answer from stored data")],
  memoryNotes: ["Ask one question max before starting a scan."],
};

const noCriteriaChange = {
  roles: null,
  locations: null,
  includeKeywords: null,
  excludeKeywords: null,
  excludeCompanies: null,
  companyTypes: null,
  workModes: null,
  seniority: null,
  sources: null,
  minSalary: null,
  maxJobs: null,
  fitThreshold: null,
} as const;

/** PM3 M3 (UC-21b a): "also include Đà Nẵng" → Lead asks just this run or save, and proposes the change. */
export const leadCriteriaProposalFixture: LeadOutput = {
  reply: "Add Đà Nẵng just for this run, or save it to your search criteria?",
  actions: [{ type: "propose_criteria_change", changes: { ...noCriteriaChange, locations: { add: ["Đà Nẵng"], remove: [] } } }],
  selfCheck: [pass("The request was turned into a workflow/task or a direct answer from stored data"), pass("No work was done directly")],
  memoryNotes: [],
};

/** PM3 S1 (UC-21): "scan every weekday at 9" → a schedule Ba creates with one click. */
export const leadScheduleProposalFixture: LeadOutput = {
  reply: "I can scan every weekday at 09:00 with your search criteria. Create the schedule?",
  actions: [{ type: "propose_schedule", schedule: { name: "Weekday morning scan", repeat: "weekdays", day: null, time: "09:00", searchProfileId: null } }],
  selfCheck: [pass("The request was turned into a workflow/task or a direct answer from stored data"), pass("No work was done directly")],
  memoryNotes: [],
};

export const researchScanFixture: ResearchScanOutput = {
  jobs: [
    {
      source: "itviec",
      url: "https://itviec.com/it-jobs/senior-frontend-engineer-react-nextjs-novapay-1234",
      title: "Senior Frontend Engineer (React/Next.js)",
      company: "NovaPay",
      companyWebsite: "https://novapay.example.com",
      location: "Ho Chi Minh City",
      workMode: "hybrid",
      salaryText: "2,000–2,800 USD",
      postedAt: "2026-10-08T09:00:00+07:00",
      language: "en",
      jdText:
        "Responsibilities\n- Build product features with React/Next.js and TypeScript\n- Work with backend on REST/GraphQL APIs\n\nRequirements\n- 4+ years frontend\n- Strong TypeScript\n- GraphQL is a plus\n\nBenefits\n- 13th month, hybrid 3/2, MacBook",
    },
    {
      source: "topcv",
      url: "https://www.topcv.vn/viec-lam/lap-trinh-vien-frontend-reactjs/2330001.html",
      title: "Lập trình viên Frontend ReactJS",
      company: "Sao Việt Tech",
      companyWebsite: null,
      location: "Hồ Chí Minh",
      workMode: "onsite",
      salaryText: "25–35 triệu",
      postedAt: null,
      language: "vi",
      jdText:
        "Mô tả công việc\n- Phát triển giao diện web bằng ReactJS/Next.js\n- Phối hợp với backend tích hợp REST API\n\nYêu cầu\n- 3+ năm kinh nghiệm ReactJS\n- Thành thạo TypeScript, HTML/CSS\n- Ưu tiên biết Redux Toolkit\n\nQuyền lợi\n- Lương tháng 13, phụ cấp ăn trưa",
    },
  ],
  pageViews: 6,
  blocked: null,
  injectionSuspected: false,
  injectionNote: null,
  selfCheck: [
    pass("Every job has a reachable URL"),
    pass("Every job has full JD text (not a snippet)"),
    pass("No job is a duplicate of another in this output"),
  ],
  memoryNotes: ['TopCV salary often hidden: read "Mức lương" field.'],
};

export const researchScanBlockedFixture: ResearchScanOutput = {
  jobs: [],
  pageViews: 1,
  blocked: { reason: "needs_login", site: "linkedin.com", detail: "LinkedIn shows the sign-in wall" },
  injectionSuspected: false,
  injectionNote: null,
  selfCheck: [{ item: "Every job has a reachable URL", passed: true, note: "no jobs read" }],
  memoryNotes: [],
};

export const researchFitFixture: ResearchFitOutput = {
  fit: {
    score: 87,
    reasons: ["React/Next.js + TypeScript ownership matches Gradion apps", "Payments flow experience (Apps Cyclone)"],
    gaps: ["Asks for GraphQL — not in master data"],
  },
  selfCheck: [pass("Every reason cites master data"), pass("Every gap names a JD requirement")],
  memoryNotes: [],
};

export const researchCompanyFixture: ResearchCompanyOutput = {
  company: {
    name: "NovaPay",
    website: "https://novapay.example.com",
    industry: "Fintech",
    size: "~250 people",
    productOrOutsource: "product",
    culture: ["ownership", "code review heavy"],
    benefits: ["13th month", "hybrid 3/2", "MacBook", "health insurance"],
    reviewsSummary: "Engineers praise ownership and code quality; some mention long release weeks.",
    sources: [
      { title: "NovaPay careers", url: "https://novapay.example.com/careers" },
      { title: "ITviec company page", url: "https://itviec.com/companies/novapay" },
    ],
    confidence: "normal",
    researchedAt: "2026-10-10T09:12:00+07:00",
  },
  selfCheck: [pass("At least 2 independent sources cited")],
  memoryNotes: [],
};

export const cvOutputFixture: CvOutput = {
  language: "en",
  tailored: {
    headline: "Software Engineer — React / Next.js / Node.js",
    contactLine: "Ba Huynh · huynhthienba4@gmail.com · +84 37 247 4489 · Ho Chi Minh City",
    summary: {
      text: "Frontend-leaning engineer who owned React/Node.js apps used by ~300 employees across four countries.",
      factIds: ["grad-1"],
    },
    sections: [
      {
        kind: "experience",
        title: "Experience",
        items: [
          {
            heading: "Software Engineer · Gradion",
            subheading: "2022 – present",
            bullets: [
              {
                text: "Owned a React/Node.js performance review app used by ~300 employees across VN, TH, SG, DE.",
                factIds: ["grad-1"],
              },
              { text: "Owned a multi-country purchase order system and invoice extraction workflow.", factIds: ["grad-2"] },
            ],
          },
        ],
      },
      {
        kind: "skills",
        title: "Skills",
        items: [
          {
            heading: null,
            subheading: null,
            bullets: [{ text: "TypeScript, React, Next.js, Node.js, PostgreSQL, Vitest, Playwright", factIds: ["skill-1"] }],
          },
        ],
      },
    ],
    layout: {
      template: "BA HUYNH — Software Engineer Resume | Refreshed",
      font: "Inter",
      accentColor: "#6c5ce7",
      columns: 1,
      sectionOrder: ["summary", "experience", "skills"],
    },
  },
  figmaFrameName: "NOVAPAY_SENIOR-FRONTEND_EN_v1",
  figmaFrameUrl: "https://www.figma.com/design/kJFoXNrTfFOtkQ515c0jHk/Resume?node-id=601-1",
  pdfPath: null,
  changeNotes: ["Led with Next.js ownership", "Dropped the education portal project to keep one page"],
  factRequests: [
    { topic: "GraphQL", question: "Have you used GraphQL in a project?", reason: "The JD lists GraphQL as a plus" },
  ],
  selfCheck: [
    pass("One A4 page"),
    pass("No hidden, clipped or overflowing text frames"),
    pass("Every bullet has factIds"),
    pass("Company name is correct"),
  ],
  memoryNotes: [],
};

export const cvViFixture: CvOutput = {
  ...cvOutputFixture,
  language: "vi",
  figmaFrameName: "SAOVIET_FRONTEND_VI_v2",
  factRequests: [],
};

export const qaPassFixture: QaOutput = {
  total: 88,
  scores: {
    jdMatch: { score: 36, justification: "Covers React/Next.js/TypeScript and payments; GraphQL missing." },
    companyTone: { score: 17, justification: "Ownership framing fits a product fintech." },
    formatAts: { score: 19, justification: "One page, clean reading order in pdfminer output." },
    clarity: { score: 16, justification: "Bullets are concrete; summary slightly long." },
  },
  hardFails: [],
  fixes: [{ section: "Summary", instruction: "Shorten to one sentence." }],
  injectionSuspected: false,
  injectionNote: null,
  selfCheck: [pass("Every score has a justification"), pass("Every fix is actionable and refers to a section")],
  memoryNotes: [],
};

export const qaFailFixture: QaOutput = {
  total: 76,
  scores: {
    jdMatch: { score: 30, justification: "JD wants Python 3+ years; master data has none." },
    companyTone: { score: 16, justification: "Neutral tone." },
    formatAts: { score: 16, justification: "Two-column layout extracts out of order in one place." },
    clarity: { score: 14, justification: "Some bullets are vague." },
  },
  hardFails: [{ code: "invented_claim", detail: "'Python automation' is not supported by grad-3", section: "Projects" }],
  fixes: [{ section: "Projects", instruction: "Remove the Python claim or cite a fact that supports it." }],
  injectionSuspected: false,
  injectionNote: null,
  selfCheck: [pass("Every score has a justification")],
  memoryNotes: [],
};

export const applyOutputFixture: ApplyOutput = {
  status: "submitted",
  fieldsFilled: [
    { label: "Full name", name: "fullname", value: "Ba Huynh", source: "master_cv", required: true },
    { label: "Email", name: "email", value: "huynhthienba4@gmail.com", source: "master_cv", required: true },
    { label: "Phone", name: "phone", value: "+84 37 247 4489", source: "master_cv", required: true },
    { label: "Preferred location", name: null, value: "Ho Chi Minh City", source: "search_profile", required: false },
    { label: "CV", name: "cv_file", value: "BA_HUYNH_NovaPay_EN_v1.pdf", source: "generated", required: true },
    { label: "Notice period", name: "notice", value: "2 weeks", source: "saved_answer", required: true },
    { label: "Expected salary (USD) · optional", name: "salary", value: null, source: "skipped", required: false },
    { label: "Salary expectation note", name: "salary_note", value: "Negotiable", source: "form_defaults", required: false },
  ],
  introText: "I have 4+ years building React/Next.js products and owned internal apps used by ~300 employees.",
  consent: { ticked: true, text: "I agree that the employer may process my personal data for recruitment." },
  uploadedFile: { filename: "BA_HUYNH_NovaPay_EN_v1.pdf", sha256: SAMPLE_SHA256 },
  preSubmitScreenshot: "data/screenshots/task_42_pre_submit.png",
  confirmationScreenshot: "data/screenshots/task_42_confirmation.png",
  confirmationText: "Your application has been submitted.",
  finalUrl: "https://itviec.com/it-jobs/senior-frontend-engineer-react-nextjs-novapay-1234/applied",
  pendingQuestions: [],
  pauseReason: null,
  jdSnapshot: {
    url: "https://itviec.com/it-jobs/senior-frontend-engineer-react-nextjs-novapay-1234",
    title: "Senior Frontend Engineer (React/Next.js)",
    company: "NovaPay",
    salaryText: "2,000–2,800 USD",
    jdText: "Responsibilities\n- Build product features with React/Next.js and TypeScript",
    pageScreenshot: "data/screenshots/task_42_jd.png",
    capturedAt: "2026-10-10T15:39:00+07:00",
  },
  injectionSuspected: false,
  injectionNote: null,
  selfCheck: [
    pass("The correct PDF filename is attached and visible, and its SHA-256 matches the approved CV version"),
    pass("All required fields are filled"),
    pass("The company and job title on the page match the approved job"),
    pass("A pre-submit screenshot of the filled form has been captured"),
  ],
  memoryNotes: [],
};

export const applyPausedFixture: ApplyOutput = {
  status: "paused",
  fieldsFilled: [{ label: "Họ và tên", name: "fullname", value: "Ba Huynh", source: "master_cv", required: true }],
  introText: null,
  consent: null,
  uploadedFile: null,
  preSubmitScreenshot: null,
  confirmationScreenshot: null,
  confirmationText: null,
  finalUrl: null,
  pendingQuestions: [
    { field: "start_date", label: "Thời gian có thể bắt đầu làm việc", required: true, kind: "text", options: null },
    { field: "salary", label: "Mức lương mong muốn (VND)", required: false, kind: "salary", options: null },
  ],
  pauseReason: { reason: "needs_answer", site: null, detail: "Required field with no saved answer" },
  jdSnapshot: null,
  injectionSuspected: false,
  injectionNote: null,
  selfCheck: [{ item: "All required fields are filled", passed: true, note: "paused before submit" }],
  memoryNotes: [],
};

export const consultReplyFixture: ConsultOutput = {
  reply: "QA failed NovaPay round 1 because a Python claim had no supporting fact.",
  handoffToLead: null,
  selfCheck: [pass("Answered within my role; no work was done")],
  memoryNotes: [],
};

export const consultHandoffFixture: ConsultOutput = {
  reply: "That's a work request, so I've handed it to Lead.",
  handoffToLead: { request: "Find AI-focused frontend roles in HCM" },
  selfCheck: [pass("Answered within my role; no work was done")],
  memoryNotes: [],
};

/** cv.fact_draft: Ba answered "Have you deployed on AWS?" with "Yes, at Gradion I deployed our Next.js apps to AWS ECS with Terraform." */
export const factDraftOutputFixture: FactDraftOutput = {
  facts: [
    {
      id: "grad-2",
      type: "experience",
      text: "Deployed the team's Next.js apps to AWS ECS with Terraform.",
      textVi: "Triển khai các ứng dụng Next.js của nhóm lên AWS ECS bằng Terraform.",
      tags: ["aws", "ecs", "terraform", "next.js"],
      org: "Gradion",
      dates: "2022 – present",
    },
  ],
  notes: null,
  selfCheck: FACT_DRAFT_SELF_CHECK.map((item) => pass(item)),
  memoryNotes: [],
};

/** cv.fact_draft: Ba said no, so there is nothing to add. */
export const factDraftNoneFixture: FactDraftOutput = {
  facts: [],
  notes: "You said you haven't used Docker, so I added nothing.",
  selfCheck: FACT_DRAFT_SELF_CHECK.map((item) => pass(item)),
  memoryNotes: [],
};

/** cv.derive: Redux implied from Ba's React portal (CV auto-extend). */
export const deriveOutputFixture: DeriveOutput = {
  drafts: [
    {
      requirement: "state management at scale",
      type: "skill",
      text: "Redux",
      textVi: "Redux",
      tags: ["redux"],
      restsOn: [{ factId: "grad-3", relation: "implied_from" }],
      fromTerms: ["React", "Next.js"],
      rationale: "Redux is the common state library for React and Next.js apps.",
    },
  ],
  selfCheck: DERIVE_SELF_CHECK.map((item) => pass(item)),
  memoryNotes: [],
};

/** cv.derive: nothing in Ba's facts supports the gaps. */
export const deriveNoneFixture: DeriveOutput = { drafts: [], selfCheck: DERIVE_SELF_CHECK.map((item) => pass(item)), memoryNotes: [] };

export const validBotOutputFixtures: Record<BotOutputSchemaName, readonly unknown[]> = {
  DeriveOutput: [deriveOutputFixture, deriveNoneFixture],
  FactDraftOutput: [factDraftOutputFixture, factDraftNoneFixture],
  LeadOutput: [leadOutputFixture, leadClarifyFixture, leadCriteriaProposalFixture, leadScheduleProposalFixture],
  ResearchScanOutput: [researchScanFixture, researchScanBlockedFixture],
  ResearchFitOutput: [researchFitFixture],
  ResearchCompanyOutput: [researchCompanyFixture],
  CvOutput: [cvOutputFixture, cvViFixture],
  QaOutput: [qaPassFixture, qaFailFixture],
  ApplyOutput: [applyOutputFixture, applyPausedFixture],
  ConsultOutput: [consultReplyFixture, consultHandoffFixture],
};
