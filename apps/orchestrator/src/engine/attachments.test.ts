// F8 (live bug 2026-10-11: Lead "can't read the screenshot"): a conversation task gets the files Ba
// attached to the message it answers as copies in its own attachments folder, and that folder is
// its one read dir. Nothing else: not another message's uploads, not a file that lies about its
// type, not a type a bot cannot view, never a work task.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendMessage, createUpload, getOrCreateLeadRoom, type Db } from "../db/index.js";
import { DATA_DIR, createTestEngine, type TestEngine } from "./testing/harness.js";
import { uploadCopyName } from "./attachments.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const PDF = Buffer.from("%PDF-1.7\n...");

function upload(t: TestEngine, filename: string, mime: string, bytes: Buffer | null) {
  const path = `uploads/${filename}`;
  if (bytes) t.files.write(join(DATA_DIR, path), bytes);
  return createUpload(t.db, { filename, mime, size: bytes?.length ?? 1, path, sha256: "a".repeat(64) });
}

function message(db: Db, uploadIds: number[]) {
  const room = getOrCreateLeadRoom(db);
  return appendMessage(db, { roomId: room.id, author: "ba", text: "What's wrong here?", uploadIds });
}

const chatInput = (messageId: number, uploadIds: number[]) => ({
  roomId: "1",
  messageId: String(messageId),
  text: "What's wrong here?",
  history: [],
  uploadIds: uploadIds.map(String),
  handoff: null,
});

describe("conversation attachments (F8)", () => {
  it("lead.chat with a screenshot: the copy in tasks/<id>/attachments is its only read dir", async () => {
    const t = await createTestEngine();
    const shot = upload(t, "Screenshot at Oct 11 5-14-30 PM.png", "image/png", PNG);
    const msg = message(t.db, [shot.id]);
    const { taskId } = t.engine.enqueueConversation({ bot: "lead", kind: "chat", input: chatInput(msg.id, [shot.id]) });
    await t.idle();
    const call = t.runner.callsFor("lead.chat")[0]!;
    const dir = join(DATA_DIR, "tasks", String(taskId), "attachments");
    const copy = join(dir, `upload-${shot.id}.png`);
    expect(call.readDirs).toEqual([dir]);
    expect(call.attachments).toEqual([{ path: copy, name: "Screenshot at Oct 11 5-14-30 PM.png", mime: "image/png" }]);
    expect(t.files.copies).toEqual([{ from: join(DATA_DIR, "uploads/Screenshot at Oct 11 5-14-30 PM.png"), to: copy }]);
    expect(t.files.files.get(copy)).toEqual(PNG);
    // Lead's tools stay its own: the grant is the runner's, per task (rule 5).
    expect(call.bot.allowedTools.every((tool) => tool.startsWith("mcp:orchestrator:"))).toBe(true);
    expect(t.tasks("lead.chat")[0]!.status).toBe("done");
  });

  it("only viewable uploads of this very message, whose bytes match their type; the rest is left out and the task still runs", async () => {
    const t = await createTestEngine();
    const shot = upload(t, "shot.png", "image/png", PNG);
    const jd = upload(t, "JD (final).pdf", "application/pdf", PDF);
    const fake = upload(t, "fake.png", "image/png", Buffer.from("MZ not a png"));
    const word = upload(t, "cv.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", Buffer.from("PK\x03\x04"));
    const gone = upload(t, "gone.png", "image/png", null);
    const msg = message(t.db, [shot.id, jd.id, fake.id, word.id, gone.id]);
    const other = upload(t, "other.png", "image/png", PNG);
    message(t.db, [other.id]);
    const ids = [shot.id, jd.id, fake.id, word.id, gone.id, other.id];
    t.engine.enqueueConversation({ bot: "lead", kind: "chat", input: chatInput(msg.id, ids) });
    await t.idle();
    const call = t.runner.callsFor("lead.chat")[0]!;
    expect(call.attachments?.map((a) => [a.name, a.mime])).toEqual([
      ["shot.png", "image/png"],
      ["JD (final).pdf", "application/pdf"],
    ]);
    expect(call.attachments?.[1]!.path).toMatch(new RegExp(`/attachments/upload-${jd.id}\\.pdf$`));
    expect(t.files.copies.map((c) => c.from)).toEqual([join(DATA_DIR, "uploads/shot.png"), join(DATA_DIR, "uploads/JD (final).pdf")]);
    expect(t.tasks("lead.chat")[0]!.status).toBe("done");
  });

  it("a consult on Codex gets them too; a message without files gets no read dir at all", async () => {
    const t = await createTestEngine();
    const shot = upload(t, "shot.png", "image/png", PNG);
    const msg = message(t.db, [shot.id]);
    const { handoff: _none, ...consult } = chatInput(msg.id, [shot.id]);
    t.engine.enqueueConversation({ bot: "qa", kind: "consult", input: consult });
    t.engine.enqueueConversation({ bot: "qa", kind: "consult", input: { ...consult, uploadIds: [] } });
    await t.idle();
    const calls = t.runner.callsFor("qa.consult");
    const files = (c: (typeof calls)[number]) => (c.input as { uploadIds: string[] }).uploadIds.length;
    const withFile = calls.find((c) => files(c) === 1);
    const without = calls.find((c) => files(c) === 0);
    expect(withFile!.bot.engine).toBe("codex");
    expect(withFile!.attachments?.map((a) => a.mime)).toEqual(["image/png"]);
    expect(withFile!.readDirs).toEqual([join(DATA_DIR, "tasks", String(withFile!.taskId), "attachments")]);
    expect(without!.attachments).toBeUndefined();
    expect(without!.readDirs).toBeUndefined();
  });

  it("copies are named by the orchestrator, never by Ba's file name", () => {
    expect(uploadCopyName({ uploadId: "7", filename: "../../etc/passwd.PNG", mime: "image/png" })).toBe("upload-7.png");
    expect(uploadCopyName({ uploadId: "8", filename: "photo.jpeg", mime: "image/jpeg" })).toBe("upload-8.jpeg");
    expect(uploadCopyName({ uploadId: "9", filename: "no extension", mime: "text/plain" })).toBe("upload-9.txt");
  });
});
