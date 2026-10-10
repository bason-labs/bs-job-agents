import { beforeEach, describe, expect, it } from "vitest";
import { openTestDb, type Db } from "../client.js";
import { at, seedBots, seedRun, seedTask, T0 } from "../test-helpers.js";
import { appendEvent, listEvents } from "./events.js";
import {
  attachUploads,
  createUpload,
  getLastExport,
  getUpload,
  listExports,
  listUploadsForMessage,
  recordExport,
} from "./files.js";
import {
  addRoomMember,
  appendMessage,
  createRoom,
  getOrCreateConsultRoom,
  getOrCreateLeadRoom,
  getRoom,
  listMessages,
  listRoomMembers,
  listRooms,
  removeRoomMember,
} from "./rooms.js";
import { deleteSavedAnswer, getSavedAnswer, listSavedAnswers, normalizeAnswerKey, saveAnswer } from "./saved-answers.js";

let db: Db;
beforeEach(() => {
  db = openTestDb();
  seedBots(db);
});

describe("events (audit log + SSE replay, §10.2 rule 8)", () => {
  it("appends and queries by run, after id, and type", () => {
    const ctx = seedRun(db);
    const task = seedTask(db, ctx);
    const e1 = appendEvent(db, { type: "run.started", payload: { runId: ctx.run.id }, runId: ctx.run.id }, { now: T0 });
    appendEvent(db, { type: "engine.paused", payload: { engine: "claude" } });
    const e3 = appendEvent(db, { type: "task.progress", payload: { line: 1 }, runId: ctx.run.id, taskId: task.id });
    expect(e1).toMatchObject({ type: "run.started", createdAt: T0.toISOString(), runId: ctx.run.id, taskId: null });
    expect(listEvents(db, { runId: ctx.run.id }).map((e) => e.id)).toEqual([e1.id, e3.id]);
    expect(listEvents(db, { afterId: e1.id }).map((e) => e.type)).toEqual(["engine.paused", "task.progress"]);
    expect(listEvents(db, { types: ["engine.paused"] })).toHaveLength(1);
    expect(listEvents(db, { taskId: task.id })[0]?.payload).toEqual({ line: 1 });
    expect(listEvents(db, { limit: 1 })).toHaveLength(1);
  });
});

describe("rooms and messages (UC-15, UC-25)", () => {
  it("has a single Lead room and one consult room per bot", () => {
    const lead = getOrCreateLeadRoom(db);
    expect(getOrCreateLeadRoom(db).id).toBe(lead.id);
    expect(lead.kind).toBe("lead");
    expect(listRoomMembers(db, lead.id)).toEqual(["lead"]);

    const qa = getOrCreateConsultRoom(db, "qa");
    expect(getOrCreateConsultRoom(db, "qa").id).toBe(qa.id);
    expect(qa).toMatchObject({ kind: "consult", botName: "qa" });
    expect(listRoomMembers(db, qa.id)).toEqual(["qa"]);
    expect(() => createRoom(db, { name: "lead-2", kind: "lead" })).toThrow(/UNIQUE/);
  });

  it("creates group rooms with members", () => {
    const room = createRoom(db, { name: "#cv-brainstorm", kind: "group", members: ["cv", "qa"] });
    expect(listRoomMembers(db, room.id)).toEqual(["cv", "qa"]);
    addRoomMember(db, room.id, "research");
    addRoomMember(db, room.id, "research");
    removeRoomMember(db, room.id, "qa");
    expect(listRoomMembers(db, room.id)).toEqual(["cv", "research"]);
    expect(listRooms(db, { kind: "group" }).map((r) => r.id)).toEqual([room.id]);
    expect(getRoom(db, room.id)?.name).toBe("#cv-brainstorm");
  });

  it("appends messages with mentions, run refs, meta and attached uploads", () => {
    const lead = getOrCreateLeadRoom(db);
    const { run } = seedRun(db);
    const up = createUpload(db, { filename: "JD.pdf", mime: "application/pdf", size: 120_000, path: "data/uploads/1/JD.pdf", sha256: "b".repeat(64) });
    const m1 = appendMessage(db, { roomId: lead.id, author: "ba", text: "Apply to this file", uploadIds: [up.id] }, { now: at(1) });
    const m2 = appendMessage(
      db,
      { roomId: lead.id, author: "lead", text: "Started apply-to-file", runRefs: [run.id], meta: { handoffFrom: "qa" } },
      { now: at(2) },
    );
    expect(m1).toMatchObject({ mentions: [], runRefs: [], meta: null, createdAt: at(1).toISOString() });
    expect(m2).toMatchObject({ runRefs: [run.id], meta: { handoffFrom: "qa" } });
    expect(listUploadsForMessage(db, m1.id).map((u) => u.id)).toEqual([up.id]);
    expect(listMessages(db, lead.id).map((m) => m.id)).toEqual([m1.id, m2.id]);
    expect(listMessages(db, lead.id, { afterId: m1.id }).map((m) => m.id)).toEqual([m2.id]);
    expect(listMessages(db, lead.id, { limit: 1 }).map((m) => m.id)).toEqual([m2.id]);
  });
});

describe("uploads (UC-24) and exports (UC-13b)", () => {
  it("stores uploads and links them to a message later", () => {
    const u = createUpload(db, { filename: "old-cv.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 50_000, path: "data/uploads/2/old-cv.docx", sha256: "c".repeat(64) }, { now: T0 });
    expect(u).toMatchObject({ uploadedAt: T0.toISOString(), messageId: null });
    const room = getOrCreateLeadRoom(db);
    const msg = appendMessage(db, { roomId: room.id, author: "ba", text: "here" });
    attachUploads(db, [u.id], msg.id);
    expect(getUpload(db, u.id)?.messageId).toBe(msg.id);
  });

  it("records exports and reports the last export date", () => {
    expect(getLastExport(db)).toBeUndefined();
    recordExport(db, { path: "data/exports/a.zip", applicationCount: 3 }, { now: at(1) });
    const last = recordExport(db, { path: "data/exports/b.zip", applicationCount: 4 }, { now: at(2) });
    expect(getLastExport(db)?.id).toBe(last.id);
    expect(listExports(db).map((e) => e.applicationCount)).toEqual([4, 3]);
  });
});

describe("saved answers (UC-12)", () => {
  it("normalises labels into keys", () => {
    expect(normalizeAnswerKey("  Notice   Period *")).toBe("notice period");
    expect(normalizeAnswerKey("Thời gian báo trước:")).toBe("thời gian báo trước");
  });

  it("upserts by normalised label", () => {
    saveAnswer(db, { label: "Notice period *", answer: "30 days" }, { now: T0 });
    saveAnswer(db, { label: "notice period", answer: "2 weeks" }, { now: at(1) });
    expect(getSavedAnswer(db, "NOTICE PERIOD")).toMatchObject({ answer: "2 weeks", updatedAt: at(1).toISOString() });
    expect(listSavedAnswers(db)).toHaveLength(1);
    deleteSavedAnswer(db, "Notice period");
    expect(listSavedAnswers(db)).toEqual([]);
  });
});
