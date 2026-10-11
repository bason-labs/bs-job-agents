// The live-shape lane's data: Ba's saved criteria and what the fake Research "finds" per source.
// The jobs look like real postings (URL shapes, full JDs), so W4a's real scan checker accepts them.
import type { JobCandidate, ResearchScanOutput, SearchProfileFields } from "@bs-job-agents/shared";
import type { RunnerTask } from "../src/runner/types.js";

export const LIVE_SHAPE_CRITERIA: SearchProfileFields = {
  roles: ["Frontend Engineer", "Software Engineer (React/Node)"],
  locations: ["Ho Chi Minh City", "Remote (VN)"],
  workModes: ["onsite", "hybrid", "remote"],
  minSalary: null,
  currency: null,
  seniority: ["mid", "senior"],
  sources: ["topcv", "itviec"],
  includeKeywords: ["React", "Next.js", "TypeScript"],
  excludeKeywords: ["PHP"],
  excludeCompanies: [],
  companyTypes: ["product"],
  languages: ["en"],
  maxJobs: 5,
  fitThreshold: 60,
  salaryPolicy: "blank_if_optional",
  salaryAmount: null,
};

const EN_JD = (product: string) =>
  `Responsibilities\n- Build ${product} features with React/Next.js and TypeScript\n- Work with backend engineers on REST and GraphQL APIs\n- Review code and help ship weekly releases\n\nRequirements\n- 4+ years of frontend work\n- Strong TypeScript and testing habits\n- GraphQL is a plus\n\nBenefits\n- 13th month salary, hybrid 3/2, MacBook, health insurance`;

export const LIVE_SHAPE_JOBS: Record<"itviec" | "topcv", JobCandidate[]> = {
  itviec: [
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
      jdText: EN_JD("payments"),
    },
    {
      source: "itviec",
      url: "https://itviec.com/it-jobs/frontend-engineer-react-kite-labs-5678",
      title: "Frontend Engineer (React)",
      company: "Kite Labs",
      companyWebsite: null,
      location: "Ho Chi Minh City",
      workMode: "remote",
      salaryText: "1,800–2,400 USD",
      postedAt: "2026-10-09T10:00:00+07:00",
      language: "en",
      jdText: EN_JD("learning platform"),
    },
  ],
  topcv: [
    {
      source: "topcv",
      url: "https://www.topcv.vn/viec-lam/frontend-developer-reactjs/2330001.html",
      title: "Frontend Developer (ReactJS)",
      company: "Mây Xanh Software",
      companyWebsite: null,
      location: "Hồ Chí Minh",
      workMode: "onsite",
      salaryText: "25–35 triệu",
      postedAt: null,
      language: "en",
      jdText: EN_JD("logistics dashboard"),
    },
  ],
};

/** research.scan's output for the task's source (its self-check is added by the caller). */
export function scanOutputFor(task: RunnerTask): Omit<ResearchScanOutput, "selfCheck"> {
  const source = (task.input as { source?: string } | null)?.source;
  const jobs = source === "itviec" || source === "topcv" ? LIVE_SHAPE_JOBS[source] : [];
  return { jobs, pageViews: jobs.length + 1, blocked: null, injectionSuspected: false, injectionNote: null, memoryNotes: [] };
}
