import { describe, expect, it } from "vitest";
import {
  applicationFixture,
  approvalTokenFixture,
  importedApplicationFixture,
  jobFixture,
  masterCvFixture,
  messageFixture,
  runFixture,
  scheduleFixture,
  searchProfileFixture,
  stepFixture,
  submissionRecordFixture,
  taskFixture,
  uploadFixture,
} from "../fixtures/domain.js";
import { cvLanguagesForJd } from "../common/primitives.js";
import {
  APPLICATION_STATUSES,
  ApplicationSchema,
  DRY_RUN_APPLICATION_STATUS,
  JobSnapshotSchema,
  SubmissionRecordSchema,
  appendStatus,
  canChangeApplicationStatus,
  canTransitionApplicationStatus,
} from "./application.js";
import { ApprovalTokenSchema } from "./approval.js";
import { MessageSchema, RoomSchema, parseMentions } from "./chat.js";
import { EngineStateSchema } from "./engine-state.js";
import { ExportSchema } from "./export.js";
import { JobSchema, SKIP_REASONS, SKIP_REASON_LABELS, SkipDecisionSchema, isApplyBlockedByInjection } from "./job.js";
import { FIELD_SOURCE_LABELS } from "../bots/apply.js";
import { MasterCvSchema } from "./master-cv.js";
import {
  PauseReasonSchema,
  RunSchema,
  StepSchema,
  TaskSchema,
  formatPauseReason,
  parsePauseReason,
} from "./run.js";
import { normalizeAnswerKey } from "./saved-answer.js";
import { ScheduleSchema, isValidCron } from "./schedule.js";
import {
  SALARY_POLICY_LABELS,
  SEARCH_PROFILE_DEFAULTS,
  SearchProfileFieldsSchema,
  SearchProfileOverridesSchema,
  SearchProfileSchema,
  applySearchOverrides,
} from "./search-profile.js";
import { UploadSchema, checkUploadFile } from "./upload.js";

const clone = <T>(v: T): T => structuredClone(v);

describe("SearchProfile (§7.5, UC-21b)", () => {
  it("accepts the fixture", () => {
    expect(SearchProfileSchema.safeParse(searchProfileFixture).success).toBe(true);
  });

  it("requires salaryAmount and currency when the salary rule is fixed", () => {
    const v = { ...clone(searchProfileFixture), salaryPolicy: "fixed" as const, salaryAmount: null };
    const r = SearchProfileSchema.safeParse(v);
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path.join("."))).toContain("salaryAmount");
    expect(SearchProfileSchema.safeParse({ ...v, salaryAmount: 30_000_000 }).success).toBe(true);
    expect(
      SearchProfileSchema.safeParse({ ...v, salaryAmount: 30_000_000, minSalary: null, currency: null }).success,
    ).toBe(false);
  });

  it.each(["blank_if_optional", "negotiable", "ask"] as const)("salaryAmount is optional under %s", (policy) => {
    expect(
      SearchProfileSchema.safeParse({ ...clone(searchProfileFixture), salaryPolicy: policy, salaryAmount: null }).success,
    ).toBe(true);
  });

  it("rejects an unknown salary policy", () => {
    expect(SearchProfileSchema.safeParse({ ...clone(searchProfileFixture), salaryPolicy: "whatever" }).success).toBe(false);
  });

  it("needs at least one role, location and source (UC-21b b)", () => {
    for (const key of ["roles", "locations", "sources"] as const) {
      const r = SearchProfileSchema.safeParse({ ...clone(searchProfileFixture), [key]: [] });
      expect(r.success, key).toBe(false);
      expect(r.error?.issues[0]?.path).toEqual([key]);
    }
  });

  it("minimum salary needs a currency", () => {
    expect(SearchProfileSchema.safeParse({ ...clone(searchProfileFixture), currency: null }).success).toBe(false);
    expect(SearchProfileSchema.safeParse({ ...clone(searchProfileFixture), minSalary: -5 }).success).toBe(false);
  });

  it("fields schema (criteria update) applies the same rules", () => {
    const { id: _i, name: _n, version: _v, active: _a, updatedAt: _u, ...fields } = clone(searchProfileFixture);
    expect(SearchProfileFieldsSchema.safeParse(fields).success).toBe(true);
    expect(SearchProfileFieldsSchema.safeParse({ ...fields, salaryPolicy: "fixed", salaryAmount: null }).success).toBe(false);
  });

  it("overrides are partial, strict and keep the salary rule", () => {
    expect(SearchProfileOverridesSchema.safeParse({ locations: ["Đà Nẵng"] }).success).toBe(true);
    expect(SearchProfileOverridesSchema.safeParse({ bogus: 1 }).success).toBe(false);
    expect(SearchProfileOverridesSchema.safeParse({ salaryPolicy: "fixed" }).success).toBe(false);
  });

  it("applySearchOverrides merges one run's overrides without touching the profile", () => {
    const merged = applySearchOverrides(searchProfileFixture, { locations: ["Đà Nẵng"], maxJobs: 3 });
    expect(merged.locations).toEqual(["Đà Nẵng"]);
    expect(merged.maxJobs).toBe(3);
    expect(searchProfileFixture.locations).not.toEqual(["Đà Nẵng"]);
    expect(applySearchOverrides(searchProfileFixture, null)).toEqual(searchProfileFixture);
  });

  it("defaults match §7.5", () => {
    expect(SEARCH_PROFILE_DEFAULTS).toMatchObject({
      seniority: ["mid", "senior"],
      sources: ["topcv", "itviec", "linkedin"],
      maxJobs: 5,
      fitThreshold: 60,
      salaryPolicy: "blank_if_optional",
      salaryAmount: null,
    });
  });

  it("§6.3 language rule", () => {
    expect(cvLanguagesForJd("vi")).toEqual(["vi", "en"]);
    expect(cvLanguagesForJd("en")).toEqual(["en"]);
    expect(cvLanguagesForJd("ja")).toEqual(["en"]);
  });
});

describe("Job", () => {
  it("accepts the fixture and rejects unknown statuses", () => {
    expect(JobSchema.safeParse(jobFixture).success).toBe(true);
    expect(JobSchema.safeParse({ ...jobFixture, status: "review" }).success).toBe(false);
  });

  it("UC-07 b: a flagged job blocks Apply until Ba confirms it (injectionClearedAt)", () => {
    const flagged = { ...jobFixture, injectionFlagged: true, injectionClearedAt: null };
    expect(JobSchema.safeParse(flagged).success).toBe(true);
    expect(isApplyBlockedByInjection(flagged)).toBe(true);
    const cleared = { ...flagged, injectionClearedAt: "2026-10-10T10:00:00+07:00" };
    expect(JobSchema.safeParse(cleared).success).toBe(true);
    expect(isApplyBlockedByInjection(cleared)).toBe(false);
    expect(isApplyBlockedByInjection(jobFixture)).toBe(false);
    // Confirming a job that was never flagged makes no sense.
    expect(JobSchema.safeParse({ ...jobFixture, injectionClearedAt: "2026-10-10T10:00:00+07:00" }).success).toBe(false);
  });

  it("skip reasons per UC-10; 'other' needs a note", () => {
    expect(SKIP_REASONS).toEqual(["salary_low", "outsourcing", "location", "tech_mismatch", "company_culture", "seniority", "other"]);
    expect(SkipDecisionSchema.safeParse({ reason: "salary_low", note: null }).success).toBe(true);
    expect(SkipDecisionSchema.safeParse({ reason: "other", note: null }).success).toBe(false);
    expect(SkipDecisionSchema.safeParse({ reason: "other", note: "too far" }).success).toBe(true);
  });
});

describe("Application + submission record (UC-13, §9.1)", () => {
  it("statuses cover UC-08/11/13", () => {
    expect(APPLICATION_STATUSES).toEqual(
      expect.arrayContaining([
        "approved",
        "paused",
        "needs_check",
        "submitted",
        "failed",
        "interviewing",
        "offer",
        "rejected",
        "withdrawn",
        "no_response",
      ]),
    );
  });

  it("accepts app and imported applications", () => {
    expect(ApplicationSchema.safeParse(applicationFixture).success).toBe(true);
    expect(ApplicationSchema.safeParse(importedApplicationFixture).success).toBe(true);
  });

  it("an app-origin application needs a CV version; imported may not", () => {
    expect(ApplicationSchema.safeParse({ ...applicationFixture, cvVersionId: null }).success).toBe(false);
  });

  it("manual status changes follow submitted → interviewing → offer | rejected | withdrawn | no_response", () => {
    expect(canChangeApplicationStatus("submitted", "interviewing")).toBe(true);
    expect(canChangeApplicationStatus("interviewing", "offer")).toBe(true);
    expect(canChangeApplicationStatus("interviewing", "rejected")).toBe(true);
    expect(canChangeApplicationStatus("needs_check", "submitted")).toBe(true);
    expect(canChangeApplicationStatus("needs_check", "failed")).toBe(true);
    expect(canChangeApplicationStatus("approved", "offer")).toBe(false);
    expect(canChangeApplicationStatus("submitted", "submitted")).toBe(false);
  });

  it("Ba moves freely between post-submit statuses, so a mis-click can be corrected (PM M3)", () => {
    expect(canChangeApplicationStatus("rejected", "interviewing")).toBe(true);
    expect(canChangeApplicationStatus("offer", "submitted")).toBe(true);
    expect(canChangeApplicationStatus("withdrawn", "no_response")).toBe(true);
    // …but never back into the apply flow, and nothing reopens a failed or pending application.
    expect(canChangeApplicationStatus("rejected", "needs_check")).toBe(false);
    expect(canChangeApplicationStatus("submitted", "failed")).toBe(false);
    expect(canChangeApplicationStatus("interviewing", "approved")).toBe(false);
    expect(canChangeApplicationStatus("failed", "submitted")).toBe(false);
    expect(canChangeApplicationStatus("approved", "submitted")).toBe(false);
    expect(canChangeApplicationStatus("paused", "failed")).toBe(false);
  });

  it("submitted comes only from the submission record or Ba settling a needs_check (PM M3)", () => {
    for (const from of ["approved", "paused"] as const) {
      expect(canTransitionApplicationStatus(from, "submitted", "system")).toBe(false);
      expect(canTransitionApplicationStatus(from, "submitted", "manual")).toBe(false);
      expect(canTransitionApplicationStatus(from, "submitted", "record")).toBe(true);
      expect(canTransitionApplicationStatus(from, "needs_check", "record")).toBe(true);
    }
    expect(canTransitionApplicationStatus("needs_check", "submitted", "system")).toBe(false);
    expect(canTransitionApplicationStatus("needs_check", "submitted", "record")).toBe(false);
    expect(canTransitionApplicationStatus("needs_check", "submitted", "manual")).toBe(true);
  });

  it("the orchestrator moves an application only within the apply flow (UC-11, UC-17, UC-18)", () => {
    expect(canTransitionApplicationStatus("approved", "paused", "system")).toBe(true);
    expect(canTransitionApplicationStatus("paused", "approved", "system")).toBe(true);
    expect(canTransitionApplicationStatus("approved", "needs_check", "system")).toBe(true);
    expect(canTransitionApplicationStatus("paused", "failed", "system")).toBe(true);
    expect(canTransitionApplicationStatus("needs_check", "failed", "system")).toBe(false);
    expect(canTransitionApplicationStatus("submitted", "interviewing", "system")).toBe(false);
    expect(canTransitionApplicationStatus("approved", "paused", "manual")).toBe(false);
    expect(canTransitionApplicationStatus("failed", "approved", "record")).toBe(false);
  });

  it("a dry run never reaches submitted or any later status (PM M3)", () => {
    expect(canTransitionApplicationStatus("approved", "needs_check", "record", { dryRun: true })).toBe(true);
    expect(canTransitionApplicationStatus("approved", "submitted", "record", { dryRun: true })).toBe(false);
    expect(canChangeApplicationStatus("needs_check", "submitted", { dryRun: true })).toBe(false);
    expect(canChangeApplicationStatus("needs_check", "failed", { dryRun: true })).toBe(true);
    // The fixture is submitted, so as a dry run it is invalid.
    expect(ApplicationSchema.safeParse({ ...applicationFixture, dryRun: true }).success).toBe(false);
    expect(ApplicationSchema.safeParse({ ...applicationFixture, status: "needs_check", dryRun: true }).success).toBe(true);
  });

  it("an application without a dryRun field is a real one (older payloads still parse)", () => {
    const { dryRun: _dryRun, ...older } = applicationFixture;
    expect(ApplicationSchema.parse(older).dryRun).toBe(false);
    expect(applicationFixture.dryRun).toBe(false);
  });

  it("appendStatus appends to history without mutating", () => {
    const next = appendStatus(applicationFixture, "interviewing", "2026-10-12T10:00:00+07:00", "HR called");
    expect(next.status).toBe("interviewing");
    expect(next.statusHistory.at(-1)).toEqual({ status: "interviewing", at: "2026-10-12T10:00:00+07:00", note: "HR called" });
    expect(applicationFixture.statusHistory).toHaveLength(next.statusHistory.length - 1);
  });

  it("submission record has every §9.1 field", () => {
    const r = SubmissionRecordSchema.parse(submissionRecordFixture);
    expect(Object.keys(r).sort()).toEqual(
      [
        "applicationId",
        "approval",
        "approvalToken",
        "confirmationScreenshotPath",
        "confirmationText",
        "consent",
        "dryRun",
        "fields",
        "finalUrl",
        "introText",
        "jdSnapshot",
        "preSubmitScreenshotPath",
        "submittedAt",
        "uploadedFile",
      ].sort(),
    );
    expect(r.uploadedFile?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(r.fields.some((f) => f.source === "skipped" && f.value === null)).toBe(true);
  });

  it("rejects a bad SHA-256 and unknown field sources", () => {
    const a = clone(submissionRecordFixture);
    a.uploadedFile!.sha256 = "ABC";
    expect(SubmissionRecordSchema.safeParse(a).success).toBe(false);
    const b = clone(submissionRecordFixture) as { fields: Array<Record<string, unknown>> };
    b.fields[0]!.source = "magic";
    expect(SubmissionRecordSchema.safeParse(b).success).toBe(false);
  });

  it("a dry-run Apply (§12) is recorded with dryRun: true and never as submitted", () => {
    expect(submissionRecordFixture.dryRun).toBe(false);
    const dry = { ...clone(submissionRecordFixture), dryRun: true, confirmationText: null, confirmationScreenshotPath: null };
    expect(SubmissionRecordSchema.safeParse(dry).success).toBe(true);
    expect(SubmissionRecordSchema.safeParse({ ...clone(submissionRecordFixture), dryRun: undefined }).success).toBe(false);
    expect(DRY_RUN_APPLICATION_STATUS).toBe("needs_check");
  });

  it("an imported record may miss parts ('not captured')", () => {
    const partial = {
      ...clone(submissionRecordFixture),
      preSubmitScreenshotPath: null,
      jdSnapshot: null,
      uploadedFile: { filename: "BA_HUYNH_DEKON_Figma_EN.pdf", sha256: null, path: null },
      approvalToken: null,
      approval: null,
    };
    expect(SubmissionRecordSchema.safeParse(partial).success).toBe(true);
  });

  it("job snapshot requires the frozen text", () => {
    expect(JobSnapshotSchema.safeParse(submissionRecordFixture.jdSnapshot).success).toBe(true);
    expect(JobSnapshotSchema.safeParse({ ...submissionRecordFixture.jdSnapshot, jdText: "" }).success).toBe(false);
  });
});

describe("Run, Step, Task (§9, UC-16/17/18)", () => {
  it("accepts fixtures", () => {
    expect(RunSchema.safeParse(runFixture).success).toBe(true);
    expect(StepSchema.safeParse(stepFixture).success).toBe(true);
    expect(TaskSchema.safeParse(taskFixture).success).toBe(true);
  });

  it("task statuses include waiting_limit, paused and interrupted", () => {
    for (const status of ["queued", "running", "waiting_limit", "paused", "done", "failed", "interrupted"]) {
      expect(TaskSchema.safeParse({ ...taskFixture, status, pauseReason: status === "paused" ? { code: "needs_browser", site: null, detail: null } : null }).success, status).toBe(true);
    }
    expect(TaskSchema.safeParse({ ...taskFixture, status: "sleeping" }).success).toBe(false);
  });

  it("a paused task needs a pause reason", () => {
    expect(TaskSchema.safeParse({ ...taskFixture, status: "paused", pauseReason: null }).success).toBe(false);
  });

  it("pause reasons: needs_browser, needs_figma, needs_login(site), captcha(site), usage_limit", () => {
    for (const code of ["needs_browser", "needs_figma", "needs_login", "captcha", "usage_limit", "needs_answer", "domain_confirm"]) {
      const site = ["needs_login", "captcha", "domain_confirm"].includes(code) ? "topcv.vn" : null;
      expect(PauseReasonSchema.safeParse({ code, site, detail: null }).success, code).toBe(true);
    }
    expect(PauseReasonSchema.safeParse({ code: "domain_confirm", site: null, detail: null }).success).toBe(false);
    expect(PauseReasonSchema.safeParse({ code: "needs_login", site: null, detail: null }).success).toBe(false);
  });

  it("formats and parses the pause_reason column", () => {
    expect(formatPauseReason({ code: "needs_login", site: "topcv.vn", detail: null })).toBe("needs_login(topcv.vn)");
    expect(formatPauseReason({ code: "needs_figma", site: null, detail: null })).toBe("needs_figma");
    expect(parsePauseReason("captcha(linkedin.com)")).toEqual({ code: "captcha", site: "linkedin.com", detail: null });
    expect(parsePauseReason("usage_limit")).toEqual({ code: "usage_limit", site: null, detail: null });
    expect(parsePauseReason("nonsense(x)")).toBeNull();
  });

  it("run triggers and statuses per §9", () => {
    expect(RunSchema.safeParse({ ...runFixture, trigger: "cron" }).success).toBe(false);
    for (const status of ["running", "waiting", "paused", "done", "failed", "cancelled"]) {
      expect(RunSchema.safeParse({ ...runFixture, status }).success, status).toBe(true);
    }
  });
});

describe("Schedule (§7.4, UC-21)", () => {
  it("accepts the fixture, including a soft-delete timestamp", () => {
    expect(ScheduleSchema.safeParse(scheduleFixture).success).toBe(true);
    expect(ScheduleSchema.safeParse({ ...scheduleFixture, deletedAt: "2026-10-10T10:00:00+07:00" }).success).toBe(true);
  });

  it("cron must have 5 fields", () => {
    expect(isValidCron("0 9 * * 1-5")).toBe(true);
    expect(isValidCron("*/30 8-18 * * MON-FRI")).toBe(true);
    expect(isValidCron("0 9 * *")).toBe(false);
    expect(isValidCron("0 0 9 * * 1-5")).toBe(false);
    expect(isValidCron("@daily")).toBe(false);
    expect(ScheduleSchema.safeParse({ ...scheduleFixture, cron: "0 9" }).success).toBe(false);
  });

  it("name is required", () => {
    expect(ScheduleSchema.safeParse({ ...scheduleFixture, name: "" }).success).toBe(false);
  });
});

describe("Upload (UC-24)", () => {
  it("accepts the fixture", () => {
    expect(UploadSchema.safeParse(uploadFixture).success).toBe(true);
  });

  it("allows PDF, DOC/DOCX, TXT, PNG/JPG up to 10 MB", () => {
    expect(checkUploadFile({ filename: "jd.pdf", mime: "application/pdf", size: 1000 })).toBeNull();
    expect(checkUploadFile({ filename: "cv.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 1 })).toBeNull();
    expect(checkUploadFile({ filename: "shot.JPG", mime: "image/jpeg", size: 1 })).toBeNull();
    expect(checkUploadFile({ filename: "big.pdf", mime: "application/pdf", size: 10 * 1024 * 1024 + 1 })).toMatch(/big\.pdf.*10 MB/);
    expect(checkUploadFile({ filename: "run.exe", mime: "application/octet-stream", size: 1 })).toMatch(/run\.exe/);
    expect(UploadSchema.safeParse({ ...uploadFixture, size: 11 * 1024 * 1024 }).success).toBe(false);
  });
});

describe("other domain records", () => {
  it("approval token (UC-08)", () => {
    expect(ApprovalTokenSchema.safeParse(approvalTokenFixture).success).toBe(true);
    expect(ApprovalTokenSchema.safeParse({ ...approvalTokenFixture, allowedDomains: [] }).success).toBe(false);
  });

  it("engine state", () => {
    expect(EngineStateSchema.safeParse({ engine: "claude", pausedUntil: "2026-10-10T14:05:00+07:00", reason: "usage_limit" }).success).toBe(true);
    expect(EngineStateSchema.safeParse({ engine: "claude", pausedUntil: null, reason: null }).success).toBe(true);
  });

  it("export", () => {
    expect(ExportSchema.safeParse({ id: "exp_1", createdAt: "2026-10-10T16:00:00+07:00", path: "data/exports/a.zip", applicationCount: 3 }).success).toBe(true);
  });

  it("master CV facts (§6.1)", () => {
    expect(MasterCvSchema.safeParse(masterCvFixture).success).toBe(true);
    const dup = clone(masterCvFixture);
    dup.facts.push(dup.facts[0]!);
    expect(MasterCvSchema.safeParse(dup).success).toBe(false);
  });

  it("UI labels use the approved prototype copy (stage0-prototype.html)", () => {
    expect(SALARY_POLICY_LABELS).toEqual({
      blank_if_optional: "Leave blank when optional",
      negotiable: "Write “Negotiable / Thỏa thuận”",
      fixed: "Use a fixed amount",
      ask: "Ask me each time",
    });
    expect(SKIP_REASON_LABELS).toEqual({
      salary_low: "Salary too low",
      outsourcing: "Outsourcing company",
      location: "Location",
      tech_mismatch: "Tech mismatch",
      company_culture: "Company culture",
      seniority: "Seniority",
      other: "Other",
    });
    expect(FIELD_SOURCE_LABELS).toEqual({
      master_cv: "master CV",
      saved_answer: "saved answer",
      ba_answer: "your answer",
      search_profile: "search criteria",
      form_defaults: "form defaults",
      generated: "generated",
      skipped: "left blank — optional",
    });
  });

  it("saved answer keys are normalised labels (UC-12)", () => {
    expect(normalizeAnswerKey("  Notice   Period: ")).toBe("notice period");
    expect(normalizeAnswerKey("Thời gian bắt đầu*")).toBe("thời gian bắt đầu");
    // QA: the DB used to strip these too, so the same label gave two different keys.
    expect(normalizeAnswerKey("Notice period?")).toBe("notice period");
    expect(normalizeAnswerKey("Mức lương mong muốn：")).toBe("mức lương mong muốn");
    expect(normalizeAnswerKey("Notice period *:")).toBe("notice period");
  });
});

describe("Rooms and messages (UC-15, UC-25)", () => {
  it("accepts the fixture", () => {
    expect(MessageSchema.safeParse(messageFixture).success).toBe(true);
    expect(RoomSchema.safeParse({ id: "room_lead", name: "Lead", kind: "lead", botName: "lead", members: ["lead"], createdAt: "2026-10-10T08:00:00+07:00" }).success).toBe(true);
  });

  it("a direct room is tied to one bot", () => {
    expect(RoomSchema.safeParse({ id: "r", name: "CV", kind: "direct", botName: null, members: ["cv"], createdAt: "2026-10-10T08:00:00+07:00" }).success).toBe(false);
  });

  it("parseMentions finds @bot mentions case-insensitively, only for known bots", () => {
    expect(parseMentions("@CV @QA how should I present the AI lab work? cc @nobody", ["cv", "qa", "lead"])).toEqual(["cv", "qa"]);
    expect(parseMentions("email me at ba@example.com", ["example"])).toEqual([]);
    expect(parseMentions("@Lead turn this into a task @lead", ["lead"])).toEqual(["lead"]);
  });
});
