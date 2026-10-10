import { describe, expect, it } from "vitest";
import {
  applicationFixture,
  jobFixture,
  scheduleFixture,
  searchProfileFixture,
  submissionRecordFixture,
  uploadFixture,
} from "../fixtures/domain.js";
import { reviewCardFixture } from "../fixtures/api.js";
import {
  ApplicationDetailSchema,
  ApplicationStatusChangeRequestSchema,
  ExportResponseSchema,
} from "./applications.js";
import { BotUpdateRequestSchema, canPromote, type CanPromoteResult } from "./bots.js";
import { AnswerQuestionRequestSchema, ChatSendRequestSchema, CreateRoomRequestSchema } from "./chat.js";
import { ApiErrorSchema, API_ROUTES, fileUrl } from "./common.js";
import { CriteriaUpdateRequestSchema } from "./criteria.js";
import { ApproveRequestSchema, ApproveResponseSchema, RequestChangesRequestSchema, ReviewCardSchema, SkipRequestSchema } from "./review.js";
import { RunControlRequestSchema } from "./runs.js";
import {
  ScheduleCreateRequestSchema,
  ScheduleUpdateRequestSchema,
  ScheduleViewSchema,
  repeatToCron,
} from "./schedules.js";
import { UploadsResponseSchema } from "./uploads.js";

describe("chat API", () => {
  it("send: text or attachments required", () => {
    expect(ChatSendRequestSchema.safeParse({ roomId: "room_lead", text: "Find frontend jobs in HCM", uploadIds: [] }).success).toBe(true);
    expect(ChatSendRequestSchema.safeParse({ roomId: "room_lead", text: "", uploadIds: ["upl_1"] }).success).toBe(true);
    expect(ChatSendRequestSchema.safeParse({ roomId: "room_lead", text: "   ", uploadIds: [] }).success).toBe(false);
  });

  it("answer question: skip has no value; answer needs one (UC-12)", () => {
    expect(AnswerQuestionRequestSchema.safeParse({ mode: "skip", value: null, remember: false }).success).toBe(true);
    expect(AnswerQuestionRequestSchema.safeParse({ mode: "negotiable", value: null, remember: false }).success).toBe(true);
    expect(AnswerQuestionRequestSchema.safeParse({ mode: "answer", value: "2 weeks", remember: true }).success).toBe(true);
    expect(AnswerQuestionRequestSchema.safeParse({ mode: "answer", value: null, remember: true }).success).toBe(false);
  });

  it("create room needs a #name and at least one bot", () => {
    expect(CreateRoomRequestSchema.safeParse({ name: "cv-brainstorm", members: ["cv", "qa"] }).success).toBe(true);
    expect(CreateRoomRequestSchema.safeParse({ name: "cv-brainstorm", members: [] }).success).toBe(false);
  });
});

describe("review API (UC-08/09/10)", () => {
  it("review card fixture parses", () => {
    const r = ReviewCardSchema.safeParse(reviewCardFixture);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });

  it("approve picks the CV version and may carry edited intro text", () => {
    expect(ApproveRequestSchema.safeParse({ cvVersionId: "cvv_2", introText: "Edited" }).success).toBe(true);
    expect(ApproveRequestSchema.safeParse({ introText: null }).success).toBe(false);
    // PM2 S2: §12 dry-run acceptance from the card (optional), and no application for a JD without an apply link (§7.3b).
    expect(ApproveRequestSchema.parse({ cvVersionId: "cvv_2", introText: null, dryRun: true }).dryRun).toBe(true);
    expect(ApproveRequestSchema.safeParse({ cvVersionId: "cvv_2", introText: null, dryRun: "yes" }).success).toBe(false);
    expect(ApproveResponseSchema.safeParse({ applicationId: null, taskId: null, approval: null }).success).toBe(true);
    expect(ApproveResponseSchema.safeParse({ applicationId: "app_1", taskId: "task_9", approval: { expiresAt: "2026-10-11T09:00:00+07:00", allowedDomains: ["itviec.com"] } }).success).toBe(true);
  });

  it("request changes needs a comment", () => {
    expect(RequestChangesRequestSchema.safeParse({ comment: "lead with Next.js" }).success).toBe(true);
    expect(RequestChangesRequestSchema.safeParse({ comment: "" }).success).toBe(false);
  });

  it("skip needs a reason, and a note for other", () => {
    expect(SkipRequestSchema.safeParse({ reason: "outsourcing", note: null }).success).toBe(true);
    expect(SkipRequestSchema.safeParse({ reason: "other", note: null }).success).toBe(false);
    expect(SkipRequestSchema.safeParse({ reason: "boring", note: null }).success).toBe(false);
  });
});

describe("criteria API (UC-21b)", () => {
  it("update validates salary and required lists", () => {
    const { id: _i, name: _n, version: _v, active: _a, updatedAt: _u, ...fields } = searchProfileFixture;
    expect(CriteriaUpdateRequestSchema.safeParse(fields).success).toBe(true);
    expect(CriteriaUpdateRequestSchema.safeParse({ ...fields, salaryPolicy: "fixed", salaryAmount: null }).success).toBe(false);
    expect(CriteriaUpdateRequestSchema.safeParse({ ...fields, roles: [] }).success).toBe(false);
  });
});

describe("schedules API (UC-21)", () => {
  it("create applies defaults (job-scan, Asia/Ho_Chi_Minh, enabled)", () => {
    const r = ScheduleCreateRequestSchema.parse({ name: "Weekday morning scan", cron: "0 9 * * 1-5", searchProfileId: null });
    expect(r).toMatchObject({ workflowName: "job-scan", timezone: "Asia/Ho_Chi_Minh", enabled: true, params: {} });
  });

  it("create validates name and 5-field cron", () => {
    expect(ScheduleCreateRequestSchema.safeParse({ name: "", cron: "0 9 * * 1-5", searchProfileId: null }).success).toBe(false);
    expect(ScheduleCreateRequestSchema.safeParse({ name: "x", cron: "0 9 * *", searchProfileId: null }).success).toBe(false);
  });

  it("update is partial and rejects unknown keys", () => {
    expect(ScheduleUpdateRequestSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(ScheduleUpdateRequestSchema.safeParse({ deletedAt: null }).success).toBe(false);
  });

  it("view adds last result", () => {
    expect(ScheduleViewSchema.safeParse({ ...scheduleFixture, lastResult: "Fri 10 Oct · 3 to review" }).success).toBe(true);
  });

  it("repeatToCron builds the modal's repeat options", () => {
    expect(repeatToCron({ freq: "weekdays", time: "09:00" })).toBe("0 9 * * 1-5");
    expect(repeatToCron({ freq: "daily", time: "18:30" })).toBe("30 18 * * *");
    expect(repeatToCron({ freq: "weekly", time: "08:00", day: "Mon" })).toBe("0 8 * * 1");
    expect(repeatToCron({ freq: "custom", time: "08:00", cron: "*/30 9-17 * * 1-5" })).toBe("*/30 9-17 * * 1-5");
    expect(() => repeatToCron({ freq: "daily", time: "25:00" })).toThrow();
  });
});

describe("applications API (UC-13, UC-13b)", () => {
  it("status change validates the status", () => {
    expect(ApplicationStatusChangeRequestSchema.safeParse({ status: "interviewing", note: null }).success).toBe(true);
    expect(ApplicationStatusChangeRequestSchema.safeParse({ status: "hired", note: null }).success).toBe(false);
  });

  it("detail combines application, job and submission record", () => {
    expect(
      ApplicationDetailSchema.safeParse({
        application: applicationFixture,
        job: { id: jobFixture.id, title: jobFixture.title, company: jobFixture.company, url: jobFixture.url, source: jobFixture.source },
        cvVersion: { id: "cvv_2", label: "NOVAPAY_SENIOR-FRONTEND_EN_v1", language: "en", pdfFileId: "file_pdf_1", figmaFrameUrl: null },
        submission: submissionRecordFixture,
        files: [{ id: "file_pdf_1", kind: "cv_pdf", filename: "BA_HUYNH_NovaPay_EN_v1.pdf", mime: "application/pdf" }],
      }).success,
    ).toBe(true);
  });

  it("export response", () => {
    expect(
      ExportResponseSchema.safeParse({
        export: { id: "exp_1", createdAt: "2026-10-10T16:00:00+07:00", path: "data/exports/a.zip", applicationCount: 3 },
        downloadUrl: "/files/exp_1?download=1",
      }).success,
    ).toBe(true);
  });
});

describe("uploads API (UC-24)", () => {
  it("lists stored uploads and rejected files", () => {
    expect(UploadsResponseSchema.safeParse({ uploads: [uploadFixture], rejected: [{ filename: "a.exe", reason: "type" }] }).success).toBe(true);
  });
});

describe("runs and bots", () => {
  it("run control actions", () => {
    for (const action of ["pause", "resume", "cancel"]) {
      expect(RunControlRequestSchema.safeParse({ action }).success).toBe(true);
    }
    expect(RunControlRequestSchema.safeParse({ action: "explode" }).success).toBe(false);
  });

  it("bot update accepts engine switch and trust level", () => {
    expect(BotUpdateRequestSchema.safeParse({ engine: "codex" }).success).toBe(true);
    expect(BotUpdateRequestSchema.safeParse({ trustLevel: 3 }).success).toBe(false);
  });

  it("Apply can never be promoted to L2 in Phase 1 (UC-19)", () => {
    expect(canPromote("apply", 1)).toEqual<CanPromoteResult>({ allowed: false, reason: "Promoting Apply to L2 is disabled in Phase 1" });
    expect(canPromote("cv", 1)).toEqual<CanPromoteResult>({ allowed: true, reason: null });
    expect(canPromote("qa", 2)).toEqual<CanPromoteResult>({ allowed: false, reason: "Already at the highest level" });
  });
});

describe("common", () => {
  it("api error shape", () => {
    expect(ApiErrorSchema.safeParse({ error: { code: "validation_failed", message: "roles: at least one role is required", details: null } }).success).toBe(true);
  });

  it("file URLs open in the viewer; download adds ?download=1 (§11 viewer rule)", () => {
    expect(fileUrl("file_1")).toBe("/files/file_1");
    expect(fileUrl("file 1", { download: true })).toBe("/files/file%201?download=1");
    expect(API_ROUTES.events).toBe("/events");
  });
});
