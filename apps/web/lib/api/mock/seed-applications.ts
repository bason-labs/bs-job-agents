// Applications seen through the API (UC-13), built from the shared fixtures plus the
// prototype's data: the three real TopCV applications of 2026-10-10 as imported, partial
// records, and one application in each state the screen must show (needs_check, dry run,
// failed). The mock orchestrator's seed for GET /applications and /applications/:id.
import type { ApplicationDetail, ApplicationListItem, FileRef, SubmissionRecord } from "@bs-job-agents/shared";
import {
  applicationFixture,
  cvOutputFixture,
  importedApplicationFixture,
  researchScanFixture,
  submissionRecordFixture,
} from "@bs-job-agents/shared/fixtures";
import type { ApplicationExtra } from "./state";

const [novapayJob, saoVietJob] = researchScanFixture.jobs as [(typeof researchScanFixture.jobs)[0], (typeof researchScanFixture.jobs)[0]];

const pdf = (id: string, filename: string, kind: FileRef["kind"] = "cv_pdf"): FileRef => ({ id, kind, filename, mime: "application/pdf" });
const png = (id: string, filename: string, kind: FileRef["kind"] = "screenshot"): FileRef => ({ id, kind, filename, mime: "image/png" });
const txt = (id: string, filename: string): FileRef => ({ id, kind: "jd_snapshot", filename, mime: "text/plain" });

const CONTACT = "Ba Huynh · huynhthienba4@gmail.com · +84 37 247 4489";

/** The three applications Ba made on TopCV before this app existed (spec §1.1, UC-13). */
function imported(key: string, company: string, title: string, url: string, at: string, cvName: string): ApplicationDetail {
  const id = `app_${key}`;
  const record: SubmissionRecord = {
    applicationId: id,
    finalUrl: null,
    fields: [
      { label: "CV", name: null, value: cvName, source: "generated" },
      { label: "Contact details", name: null, value: CONTACT, source: "master_cv" },
      { label: "Preferred location", name: null, value: "Ho Chi Minh City", source: "search_profile" },
    ],
    introText: null,
    consent: { ticked: true, text: "Employer personal-data-use agreement (TopCV)" },
    uploadedFile: { filename: cvName, sha256: null, path: `data/applications/${id}/${cvName}` },
    preSubmitScreenshotPath: null,
    confirmationScreenshotPath: `data/applications/${id}/confirmation.png`,
    confirmationText: "Ứng tuyển việc làm thành công!",
    approvalToken: null,
    approval: { approvedAt: "2026-10-10T15:36:00+07:00", cvVersionId: null, allowedDomains: ["topcv.vn"], note: "approved in chat (earlier Codex session)" },
    submittedAt: at,
    jdSnapshot: null,
    dryRun: false,
  };
  return {
    application: {
      ...importedApplicationFixture,
      id,
      jobId: `job_${key}`,
      submittedAt: at,
      statusHistory: [{ status: "submitted", at, note: "imported" }],
    },
    job: { id: `job_${key}`, title, company, url, source: "topcv" },
    cvVersion: null,
    submission: record,
    files: [pdf(`file_${key}_cv`, cvName), png(`file_${key}_confirmation`, "confirmation.png")],
  };
}

const novapay: ApplicationDetail = {
  application: applicationFixture,
  job: { id: "job_1", title: novapayJob.title, company: novapayJob.company, url: novapayJob.url, source: novapayJob.source },
  cvVersion: {
    id: "cvv_2",
    label: cvOutputFixture.figmaFrameName,
    language: "en",
    pdfFileId: "file_app1_cv",
    figmaFrameUrl: cvOutputFixture.figmaFrameUrl,
  },
  // The API never returns token values (PM S18).
  submission: { ...submissionRecordFixture, approvalToken: null },
  files: [
    pdf("file_app1_cv", "BA_HUYNH_NovaPay_EN_v1.pdf"),
    png("file_app1_pre", "pre-submit.png"),
    png("file_app1_confirmation", "confirmation.png"),
    png("file_app1_jd_png", "jd.png", "jd_screenshot"),
    txt("file_app1_jd", "jd.txt"),
  ],
};

const SAOVIET_CV = "BA_HUYNH_SaoVietTech_VI_v2.pdf";
const saoViet: ApplicationDetail = {
  application: {
    id: "app_2",
    jobId: "job_2",
    cvVersionId: "cvv_5",
    submittedAt: "2026-10-11T08:16:00+07:00",
    status: "needs_check",
    origin: "app",
    statusHistory: [
      { status: "approved", at: "2026-10-11T08:12:00+07:00", note: null },
      { status: "needs_check", at: "2026-10-11T08:16:00+07:00", note: "No confirmation detected after submit" },
    ],
    dryRun: false,
  },
  job: { id: "job_2", title: saoVietJob.title, company: saoVietJob.company, url: saoVietJob.url, source: saoVietJob.source },
  cvVersion: {
    id: "cvv_5",
    label: "SAOVIET_FRONTEND_VI_v2",
    language: "vi",
    pdfFileId: "file_app2_cv",
    figmaFrameUrl: "https://www.figma.com/design/kJFoXNrTfFOtkQ515c0jHk/Resume?node-id=601-9",
  },
  submission: {
    applicationId: "app_2",
    finalUrl: null,
    fields: [
      { label: "Họ và tên", name: "fullname", value: "Ba Huynh", source: "master_cv" },
      { label: "Email", name: "email", value: "huynhthienba4@gmail.com", source: "master_cv" },
      { label: "Số điện thoại", name: "phone", value: "+84 37 247 4489", source: "master_cv" },
      { label: "Địa điểm mong muốn", name: null, value: "Ho Chi Minh City", source: "search_profile" },
      { label: "CV", name: "cv_file", value: SAOVIET_CV, source: "generated" },
      { label: "Mức lương mong muốn (VND) · không bắt buộc", name: "salary", value: null, source: "skipped" },
      { label: "Thời gian có thể bắt đầu làm việc", name: "start_date", value: "2 tuần sau khi nhận offer", source: "ba_answer" },
    ],
    introText: "Tôi có hơn 4 năm kinh nghiệm ReactJS/Next.js, từng phụ trách ứng dụng nội bộ cho ~300 nhân viên. Rất mong được đóng góp cho Sao Việt Tech.",
    consent: { ticked: true, text: "Tôi đồng ý cho nhà tuyển dụng sử dụng thông tin cá nhân của tôi cho mục đích tuyển dụng." },
    uploadedFile: {
      filename: SAOVIET_CV,
      sha256: "5ece7aef3d80b5fc05faeee2c752ac7ece09e798c7a048af849acb9e7d675b57",
      path: `data/applications/app_2/${SAOVIET_CV}`,
    },
    preSubmitScreenshotPath: "data/applications/app_2/pre-submit.png",
    confirmationScreenshotPath: null,
    confirmationText: null,
    approvalToken: null,
    approval: {
      approvedAt: "2026-10-11T08:12:00+07:00",
      cvVersionId: "cvv_5",
      allowedDomains: ["topcv.vn"],
      note: `token for ${SAOVIET_CV} on topcv.vn (single use)`,
    },
    submittedAt: "2026-10-11T08:16:00+07:00",
    jdSnapshot: {
      applicationId: "app_2",
      capturedAt: "2026-10-11T08:14:00+07:00",
      url: saoVietJob.url!,
      title: saoVietJob.title,
      company: saoVietJob.company,
      salaryText: saoVietJob.salaryText,
      jdText: saoVietJob.jdText,
      pageScreenshotPath: "data/applications/app_2/jd.png",
    },
    dryRun: false,
  },
  files: [pdf("file_app2_cv", SAOVIET_CV), png("file_app2_pre", "pre-submit.png"), png("file_app2_jd_png", "jd.png", "jd_screenshot"), txt("file_app2_jd", "jd.txt")],
};

const KITE_CV = "BA_HUYNH_KiteLabs_EN_v3.pdf";
const KITE_URL = "https://www.linkedin.com/jobs/view/4012345678";
const kiteLabs: ApplicationDetail = {
  application: {
    id: "app_3",
    jobId: "job_3",
    cvVersionId: "cvv_7",
    submittedAt: null,
    status: "needs_check",
    origin: "app",
    statusHistory: [
      { status: "approved", at: "2026-10-11T07:40:00+07:00", note: "dry run" },
      { status: "needs_check", at: "2026-10-11T07:44:00+07:00", note: "Dry run: form filled, submit not clicked" },
    ],
    dryRun: true,
  },
  job: { id: "job_3", title: "Software Engineer — AI Workflows", company: "Kite Labs", url: KITE_URL, source: "linkedin" },
  cvVersion: { id: "cvv_7", label: "KITELABS_SOFTWARE-ENGINEER_EN_v3", language: "en", pdfFileId: "file_app3_cv", figmaFrameUrl: null },
  submission: {
    applicationId: "app_3",
    finalUrl: null,
    fields: [
      { label: "Full name", name: "name", value: "Ba Huynh", source: "master_cv" },
      { label: "Email", name: "email", value: "huynhthienba4@gmail.com", source: "master_cv" },
      { label: "Resume", name: "resume", value: KITE_CV, source: "generated" },
      { label: "Years of Python experience", name: "python_years", value: "1", source: "ba_answer" },
      { label: "Expected salary (USD) · optional", name: "salary", value: null, source: "skipped" },
    ],
    introText: "I build AI-assisted workflows with n8n and Genkit and own Node.js backends end to end; Kite Labs' async, writing-heavy culture fits how I work.",
    consent: { ticked: true, text: "I agree to Kite Labs processing my data for this application." },
    uploadedFile: {
      filename: KITE_CV,
      sha256: "29d80efb5786933d09cf08471d775e3efe313be70365120aaba57d514108e179",
      path: `data/applications/app_3/${KITE_CV}`,
    },
    preSubmitScreenshotPath: "data/applications/app_3/pre-submit.png",
    confirmationScreenshotPath: null,
    confirmationText: null,
    approvalToken: null,
    approval: { approvedAt: "2026-10-11T07:40:00+07:00", cvVersionId: "cvv_7", allowedDomains: ["linkedin.com"], note: "dry-run token (never submits)" },
    submittedAt: null,
    jdSnapshot: {
      applicationId: "app_3",
      capturedAt: "2026-10-11T07:42:00+07:00",
      url: KITE_URL,
      title: "Software Engineer — AI Workflows",
      company: "Kite Labs",
      salaryText: null,
      jdText: "Software Engineer — AI Workflows\nRemote (VN)\n\nWhat you'll do\n- Build AI workflow features end to end\n- Own Node.js services\n\nRequirements\n- 3+ years Python\n- Experience with LLM tooling",
      pageScreenshotPath: null,
    },
    dryRun: true,
  },
  files: [pdf("file_app3_cv", KITE_CV), png("file_app3_pre", "pre-submit.png"), txt("file_app3_jd", "jd.txt")],
};

const bluebird: ApplicationDetail = {
  application: {
    id: "app_4",
    jobId: "job_4",
    cvVersionId: "cvv_8",
    submittedAt: null,
    status: "failed",
    origin: "app",
    statusHistory: [
      { status: "approved", at: "2026-10-10T17:02:00+07:00", note: null },
      { status: "failed", at: "2026-10-10T17:05:00+07:00", note: "The page showed a different company than the approved job" },
    ],
    dryRun: false,
  },
  job: {
    id: "job_4",
    title: "Frontend Engineer (Vue/Nuxt)",
    company: "Bluebird Software",
    url: "https://itviec.com/it-jobs/frontend-engineer-vue-nuxt-bluebird-5678",
    source: "itviec",
  },
  cvVersion: { id: "cvv_8", label: "BLUEBIRD_FRONTEND_EN_v1", language: "en", pdfFileId: "file_app4_cv", figmaFrameUrl: null },
  submission: null,
  files: [pdf("file_app4_cv", "BA_HUYNH_Bluebird_EN_v1.pdf")],
};

export const APPLICATION_DETAILS: ApplicationDetail[] = [
  novapay,
  saoViet,
  kiteLabs,
  bluebird,
  imported("dekon", "DEKON", "Senior Developer (NodeJS, ReactJS, AI)", "https://www.topcv.vn/viec-lam/senior-developer-nodejs-reactjs-ai/2316742.html", "2026-10-10T15:40:00+07:00", "BA_HUYNH_DEKON_Figma_EN.pdf"),
  imported("smartbit", "SMARTBIT", "Frontend Developer", "https://www.topcv.vn/viec-lam/frontend-developer/2298533.html", "2026-10-10T15:44:00+07:00", "BA_HUYNH_SMARTBIT_Figma_EN.pdf"),
  imported("yaviet", "YAVIET", "Frontend Developer (ReactJS, NextJS, TS)", "https://www.topcv.vn/viec-lam/frontend-developer-reactjs-nextjs-typescript/2325969.html", "2026-10-10T15:38:00+07:00", "BA_HUYNH_YAVIET_Figma_EN.pdf"),
];

/** What the API shows beside an application, from its full record (W3a views/applications.ts). */
export function extraOf(d: ApplicationDetail): ApplicationExtra {
  const s = d.submission;
  const confirmation = s?.confirmationScreenshotPath ? d.files.find((f) => f.kind === "screenshot" && s.confirmationScreenshotPath?.endsWith(f.filename)) : undefined;
  const cvFile = d.files.find((f) => f.kind === "cv_pdf") ?? null;
  const missing = !s || (!s.dryRun && (!s.preSubmitScreenshotPath || !s.confirmationScreenshotPath || !s.jdSnapshot || !s.uploadedFile?.sha256));
  return {
    job: d.job,
    cvVersion: d.cvVersion,
    submission: d.submission,
    files: d.files,
    confirmationScreenshotFileId: confirmation?.id ?? null,
    partialRecord: d.application.origin === "imported" || (d.submission !== null && missing),
    cvFile,
  };
}

/** The list row GET /applications returns for a detail. */
export function toRow(d: ApplicationDetail): ApplicationListItem {
  const { job, cvVersion, confirmationScreenshotFileId, partialRecord, cvFile } = extraOf(d);
  return { application: d.application, job, cvVersion, confirmationScreenshotFileId, partialRecord, cvFile };
}

/** Sample files under public/dev for the viewer, by the seeded files' types. */
export function sampleFileUrls(details: readonly ApplicationDetail[]): Record<string, string> {
  const byMime: Record<string, string> = {
    "application/pdf": "/dev/sample-cv.pdf",
    "image/png": "/dev/sample-screenshot.png",
    "text/plain": "/dev/sample-jd.txt",
  };
  const out: Record<string, string> = {};
  for (const d of details) for (const f of d.files) if (byMime[f.mime]) out[f.id] = byMime[f.mime]!;
  return out;
}
