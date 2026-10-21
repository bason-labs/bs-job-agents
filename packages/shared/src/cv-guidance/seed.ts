// The seed rule set (§5.2; AD-10, REQ-30, REQ-31): the eight points of the VNPT recruiter post (the
// image is copied to docs/cv-guidance/vnpt-cv-tips-2026-10.png and transcribed here; its positions
// are pinned) plus rules from three other recruiter and job-board pages that were fetched and quoted
// at build time (2026-10-19, the orchestrator's main-text extraction). Each web quote occurs in that
// page's extracted text; contentHash is the sha256 of guidanceContentKey(text), so the first refresh
// finds the page unchanged and spends no extraction call. Pages tried and dropped: jobscan.co (403),
// and guessed itviec.com, topcv.vn, vietnamworks.com, workable.com and greenhouse.com paths (404).
// At start the orchestrator commits whatever of this seed the current snapshot lacks, through the
// same screen and commit path as a refresh (AD-10), so it is logged.
import { GuidanceRuleSetSchema, type GuidanceRuleSet, type GuidanceRuleSetInput } from "./schema.js";
import { attachmentHost, constraintsOverriding } from "./text.js";

export const VNPT_SOURCE_ID = "vnpt-2026-10";
export const VNPT_PUBLISHER = "VNPT (Tuyển dụng VNPT)";
/** The repo copy of the attachment (`.vtc/state/` is gitignored). */
export const VNPT_REPO_PATH = "docs/cv-guidance/vnpt-cv-tips-2026-10.png";

/** When the web seed pages were fetched for the seed. */
const FETCHED = "2026-10-19T17:05:00.000Z";

const raw: GuidanceRuleSetInput = {
  sources: [
    {
      id: VNPT_SOURCE_ID,
      title: "Gửi CV mãi nhưng chưa được phản hồi? (CV tips for IT candidates)",
      publisher: VNPT_PUBLISHER,
      url: null,
      repoPath: VNPT_REPO_PATH,
      retrievedAt: "2026-10-18T07:42:19.000Z",
      kind: "attachment",
      market: "vn",
      host: attachmentHost(VNPT_PUBLISHER),
    },
    {
      id: "indeed-effective-resume",
      title: "How to Make a Resume More Effective (With Example) | Indeed.com",
      publisher: "Indeed",
      url: "https://www.indeed.com/career-advice/resumes-cover-letters/how-to-make-a-resume-with-examples",
      repoPath: null,
      retrievedAt: FETCHED,
      kind: "global_recruiter",
      market: "global",
      host: "indeed.com",
      contentHash: "3a00d3c913c9191e8d811de3a387355004f20a5460d36bfc80d6d26624d728d6",
    },
    {
      id: "topcv-viet-cv",
      title: "Viết CV như thế nào cho chuẩn và ấn tượng?",
      publisher: "TopCV",
      url: "https://www.topcv.vn/cach-viet-cv-xin-viec",
      repoPath: null,
      retrievedAt: FETCHED,
      kind: "vn_recruiter",
      market: "vn",
      host: "topcv.vn",
      contentHash: "311b2c5d53bbf7158d14d4d652545c5e3e8bbfd192ab138bdf8dee60e05a0657",
    },
    {
      id: "itviec-mau-cv-an-tuong",
      title: "Mẫu CV ấn tượng theo gợi ý của nhà tuyển dụng IT có gì? - ITviec Blog",
      publisher: "ITviec",
      url: "https://itviec.com/blog/huong-dan-viet-mau-cv-an-tuong-cho-it/",
      repoPath: null,
      retrievedAt: FETCHED,
      kind: "vn_recruiter",
      market: "vn",
      host: "itviec.com",
      contentHash: "ab2c791b46601bd77f47b0017b5113b0ed7b00a5da9e2fe785a875d3bd8f9564",
    },
  ],
  rules: [
    {
      // (a)
      id: "dates-month-year",
      topic: "dates",
      point: "Education and experience dates give month and year",
      check: "month_year",
      appliesWhen: "always",
      overriddenBy: [],
      positions: [
        {
          id: "vnpt-month-year",
          text: "Give month and year on every education, experience and certificate date (06/2023 – 08/2025, not 2023 – 2025).",
          sourceIds: [VNPT_SOURCE_ID, "itviec-mau-cv-an-tuong"],
          evidence: [
            { sourceId: VNPT_SOURCE_ID, quote: "Các mục Học vấn & Kinh nghiệm nên ghi đầy đủ tháng/năm. ❌ 2023 – 2025: Software Developer ✅ 06/2023 – 08/2025: Software Developer" },
            { sourceId: "itviec-mau-cv-an-tuong", quote: "Thời gian làm việc được ghi và sắp xếp như thế nào, chỉ có năm hay có cả năm và tháng?" },
          ],
        },
      ],
    },
    {
      // (b)
      id: "order-most-relevant-first",
      topic: "order",
      point: "The most relevant experience comes first",
      check: "judgement",
      appliesWhen: "always",
      overriddenBy: [],
      positions: [
        {
          id: "vnpt-most-relevant-first",
          text: "Lead with the experience most relevant to the role: its projects and strongest tech stack stand out first.",
          sourceIds: [VNPT_SOURCE_ID],
          evidence: [{ sourceId: VNPT_SOURCE_ID, quote: "Đưa kinh nghiệm phù hợp nhất với vị trí ứng tuyển lên đầu. … Kinh nghiệm liên quan nhất → đặt trước. Tech stack quan trọng nhất → làm nổi bật." }],
        },
      ],
    },
    {
      // (c)
      id: "bullet-what-tech-result",
      topic: "bullet_content",
      point: "Each experience item says what was done, with which technology, and what result came of it",
      check: "judgement",
      appliesWhen: "always",
      overriddenBy: [],
      positions: [
        {
          id: "vnpt-what-tech-result",
          text: "Describe each experience item as what you did, with which technology, and what result it had.",
          sourceIds: [VNPT_SOURCE_ID, "indeed-effective-resume", "topcv-viet-cv"],
          evidence: [
            { sourceId: VNPT_SOURCE_ID, quote: "Mô tả rõ: Bạn làm gì – dùng công nghệ gì – tạo ra kết quả gì." },
            { sourceId: "indeed-effective-resume", quote: "Focus on outcomes to give employers clear context about your accomplishments." },
            { sourceId: "topcv-viet-cv", quote: "Đưa ra minh chứng cụ thể, hoặc số liệu xác thực" },
          ],
        },
      ],
    },
    {
      // (d)
      id: "contact-complete",
      topic: "contact",
      point: "Name, phone and email are present and correct",
      check: "contact_present",
      appliesWhen: "always",
      overriddenBy: [],
      positions: [
        {
          id: "vnpt-contact",
          text: "Show full name, phone number and email, complete and correct.",
          sourceIds: [VNPT_SOURCE_ID, "indeed-effective-resume"],
          evidence: [
            { sourceId: VNPT_SOURCE_ID, quote: "Họ tên, SĐT, Email đầy đủ & chính xác" },
            { sourceId: "indeed-effective-resume", quote: "Your resume typically begins with your name and basic contact details, such as a professional email address and a phone number." },
          ],
        },
      ],
    },
    {
      // (e)
      id: "links-profile",
      topic: "links",
      point: "LinkedIn, GitHub or portfolio links are shown when they exist",
      check: "links_present",
      appliesWhen: "has_profile_link",
      overriddenBy: [],
      positions: [
        {
          id: "vnpt-links",
          text: "Show your LinkedIn, GitHub or portfolio link when you have one.",
          sourceIds: [VNPT_SOURCE_ID, "indeed-effective-resume"],
          evidence: [
            { sourceId: VNPT_SOURCE_ID, quote: "LinkedIn/GitHub/Portfolio nếu có" },
            { sourceId: "indeed-effective-resume", quote: "You may also choose to include a link to an online portfolio, personal website or professional profile" },
          ],
        },
      ],
    },
    {
      // (f)
      id: "skills-jd-relevant",
      topic: "skills",
      point: "The listed skills are those relevant to the JD",
      check: "judgement",
      appliesWhen: "always",
      overriddenBy: [],
      positions: [
        {
          id: "vnpt-skills-jd",
          text: "Feature the skills and tech stack that are relevant to the JD.",
          sourceIds: [VNPT_SOURCE_ID, "itviec-mau-cv-an-tuong", "topcv-viet-cv", "indeed-effective-resume"],
          evidence: [
            { sourceId: VNPT_SOURCE_ID, quote: "Skills/Tech Stack liên quan đến JD" },
            { sourceId: "itviec-mau-cv-an-tuong", quote: "Các mẫu CV ấn tượng đều có phần Kỹ năng được chọn lọc và có liên quan đến mô tả công việc." },
            { sourceId: "topcv-viet-cv", quote: "hãy ưu tiên những kỹ năng có liên quan tới công việc bạn đang ứng tuyển" },
            { sourceId: "indeed-effective-resume", quote: "Reviewing the job description can help you identify which skills to feature and how to describe them." },
          ],
        },
      ],
    },
    {
      // (g)
      id: "skills-practical-experience",
      topic: "skills",
      point: "No technology is listed without practical experience",
      check: "practical_experience",
      appliesWhen: "always",
      overriddenBy: [],
      positions: [
        {
          id: "vnpt-no-unpractised-tech",
          text: "Do not list technologies you have no practical experience with.",
          sourceIds: [VNPT_SOURCE_ID, "indeed-effective-resume"],
          evidence: [
            { sourceId: VNPT_SOURCE_ID, quote: "Không liệt kê quá nhiều công nghệ nhưng không có kinh nghiệm thực tế" },
            { sourceId: "indeed-effective-resume", quote: "When listing skills, focus on those you have used in a practical way and can support with examples elsewhere on your resume." },
          ],
        },
      ],
    },
    {
      // (h): disputed (VNPT 1–2 pages, Indeed one page early on); overridden by QA's one-page hard fail either way.
      id: "length-pages",
      topic: "length",
      point: "How many pages the CV has",
      check: "page_length",
      appliesWhen: "always",
      overriddenBy: ["over_one_page"],
      positions: [
        {
          id: "vnpt-one-to-two-pages",
          text: "Keep the CV to 1–2 pages with an easy-to-read layout.",
          sourceIds: [VNPT_SOURCE_ID],
          evidence: [{ sourceId: VNPT_SOURCE_ID, quote: "CV ưu tiên 1–2 trang, bố cục dễ đọc" }],
        },
        {
          id: "indeed-one-page-early",
          text: "One page early in a career or when changing paths; two pages only after more than a decade of experience.",
          sourceIds: ["indeed-effective-resume"],
          evidence: [{ sourceId: "indeed-effective-resume", quote: "Professionals with more than a decade of experience may expand to two pages." }],
        },
      ],
    },
    {
      id: "order-reverse-chronological",
      topic: "order",
      point: "Roles are listed in reverse chronological order",
      check: "judgement",
      appliesWhen: "always",
      overriddenBy: [],
      positions: [
        {
          id: "reverse-chronological",
          text: "List work experience in reverse chronological order, most recent role first.",
          sourceIds: ["indeed-effective-resume", "topcv-viet-cv", "itviec-mau-cv-an-tuong"],
          evidence: [
            { sourceId: "indeed-effective-resume", quote: "This section is often organized in reverse chronological order, starting with your most recent role and working backward." },
            { sourceId: "topcv-viet-cv", quote: "Liệt kê theo thứ tự thời gian, công việc làm gần đây nhất nêu trước các công việc trước đó." },
            { sourceId: "itviec-mau-cv-an-tuong", quote: "Trình bày theo thứ tự thời gian đảo ngược: Đây là cách trình bày thân thiện nhất với cả người đọc lẫn máy đọc." },
          ],
        },
      ],
    },
    {
      id: "ats-standard-headings",
      topic: "layout_ats",
      point: "Section headings are the conventional ones",
      check: "judgement",
      appliesWhen: "always",
      overriddenBy: [],
      positions: [
        {
          id: "standard-headings",
          text: "Use conventional section headings such as Work Experience and Education so an ATS can read them.",
          sourceIds: ["itviec-mau-cv-an-tuong"],
          evidence: [{ sourceId: "itviec-mau-cv-an-tuong", quote: "Sử dụng các tiêu đề truyền thống như “Kinh nghiệm làm việc” hoặc “Học vấn” để không gây nhầm lẫn cho ATS." }],
        },
      ],
    },
    {
      id: "ats-single-column",
      topic: "layout_ats",
      point: "The layout keeps to one column",
      check: "judgement",
      appliesWhen: "always",
      overriddenBy: [],
      positions: [
        {
          id: "avoid-columns",
          text: "Avoid splitting the CV into columns: an ATS may read two columns as one.",
          sourceIds: ["itviec-mau-cv-an-tuong"],
          evidence: [{ sourceId: "itviec-mau-cv-an-tuong", quote: "Hạn chế chia cột vì ATS cũng có thể “đọc” thông tin ở 2 cột thành 1." }],
        },
      ],
    },
    {
      id: "consistent-formats",
      topic: "other",
      point: "Dates, titles and formatting are consistent across sections",
      check: "judgement",
      appliesWhen: "always",
      overriddenBy: [],
      positions: [
        {
          id: "consistent-formats",
          text: "Write dates, titles and formatting the same way in every section.",
          sourceIds: ["indeed-effective-resume"],
          evidence: [{ sourceId: "indeed-effective-resume", quote: "confirming that dates, titles and formatting are used the same way across sections" }],
        },
      ],
    },
  ],
};

/** The VNPT post's eight points (REQ-30.AC-1 a–h), by rule id. */
export const VNPT_RULE_IDS = [
  "dates-month-year",
  "order-most-relevant-first",
  "bullet-what-tech-result",
  "contact-complete",
  "links-profile",
  "skills-jd-relevant",
  "skills-practical-experience",
  "length-pages",
] as const;

/** The seed, validated; overriddenBy is recomputed by code like any refresh. */
export const GUIDANCE_SEED: GuidanceRuleSet = (() => {
  const set = GuidanceRuleSetSchema.parse(raw);
  for (const rule of set.rules) {
    rule.overriddenBy = [...new Set(rule.positions.flatMap((p) => constraintsOverriding(rule.topic, p.text)))].sort();
  }
  return set;
})();
