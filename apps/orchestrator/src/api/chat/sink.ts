// PM2 S20 on F2's S2 seam: the ConversationSink. The engine calls it inside the transaction that
// settles a conversation task, so each reply (and a UC-25 a handoff) is stored atomically with the
// result.
// - Lead's chat (UC-01): Lead's reply, with the delegation trace and run cards built from what Lead
//   actually did through its MCP tools (the capability log), never from ids the model wrote.
// - Consult (UC-25) and room (UC-15) replies: the bot's answer in its room. A reply that hands work
//   to Lead (rule 1) carries a handoff card ("Open Lead chat"); Lead's chat gets "Handed over from
//   @Bot: …" and a lead.chat task, queued in the same transaction (ctx.enqueue).
// - A conversation that failed for good gets a short note from the bot (no internals).
import type { ConsultOutput, LeadAction, LeadOutput, MessageCard } from "@bs-job-agents/shared";
import { getOrCreateLeadRoom, getRoom, type Room } from "../../db/index.js";
import type { ConversationResult, ConversationSink, ConversationSinkContext, Logger } from "../../engine/index.js";
import type { CapabilityStore, LeadToolAction } from "../../mcp/capabilities.js";
import { REPLY_TEXT_MAX, clip, conversationHistory, postMessage } from "./messages.js";

const BOT_LABEL: Record<string, string> = { lead: "Lead", research: "Research", cv: "CV", qa: "QA", apply: "Apply" };
export const botLabel = (bot: string): string => BOT_LABEL[bot] ?? bot;

/** Which bot a workflow's first steps go to (the delegation trace names it). */
const WORKFLOW_FIRST_BOT: Record<string, string> = { "job-scan": "research", "apply-to-link": "research", "apply-to-file": "research" };

interface ConversationInputLike {
  roomId?: unknown;
  text?: unknown;
  uploadIds?: unknown;
}

function numericId(raw: unknown): number | null {
  const n = typeof raw === "string" && /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(n) ? n : null;
}

/** The delegation trace and run cards for what Lead did, with Lead's own summaries where they match. */
export function leadCards(recorded: readonly LeadToolAction[], output: LeadOutput): { cards: MessageCard[]; runRefs: number[] } {
  const cards: MessageCard[] = [];
  const runRefs: number[] = [];
  const said = output.actions;
  const summaryFor = (match: (a: LeadAction) => boolean): string | null => {
    const a = said.find(match) as { summary?: string } | undefined;
    return a?.summary ? clip(a.summary, 200) : null;
  };
  for (const action of recorded) {
    if (action.type === "start_workflow") {
      const summary = summaryFor((a) => a.type === "start_workflow" && (a.runId === String(action.runId) || a.workflow === action.workflow));
      cards.push({ type: "delegation", bot: WORKFLOW_FIRST_BOT[action.workflow] ?? "research", task: summary ?? `${action.workflow} run #${action.runId}`, status: "running" });
      cards.push({ type: "run", runId: String(action.runId) });
      runRefs.push(action.runId);
    } else if (action.type === "create_task") {
      const summary = summaryFor((a) => a.type === "create_task" && (a.taskId === String(action.taskId) || (a.bot === action.bot && a.kind === action.kind)));
      cards.push({ type: "delegation", bot: action.bot, task: summary ?? `${action.bot}.${action.kind} task #${action.taskId}`, status: "queued" });
    }
  }
  // UC-01 a: one clarifying question, with its suggested answers as chips.
  const ask = said.find((a): a is Extract<LeadAction, { type: "ask_user" }> => a.type === "ask_user");
  if (ask && ask.choices.length > 0) {
    cards.push({
      type: "choice",
      key: "ask_user",
      options: ask.choices.slice(0, 6).map((label, i) => ({ id: String(i + 1), label: clip(label, 120) })),
      chosen: null,
    });
  }
  return { cards, runRefs };
}

export interface ChatSinkOptions {
  now?: () => Date;
  capabilities?: CapabilityStore | null;
  log?: Logger;
}

export class ChatSink implements ConversationSink {
  private now: () => Date;
  private capabilities: CapabilityStore | null;
  private log: Logger | null;

  constructor(opts: ChatSinkOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.capabilities = opts.capabilities ?? null;
    this.log = opts.log ?? null;
  }

  /** Late binding: the clock and capability log exist once the engine and MCP server do. */
  bind(opts: ChatSinkOptions): void {
    if (opts.now) this.now = opts.now;
    if (opts.capabilities !== undefined) this.capabilities = opts.capabilities;
    if (opts.log) this.log = opts.log;
  }

  private roomOf(ctx: ConversationSinkContext): Room | null {
    const id = numericId((ctx.task.input as ConversationInputLike | null)?.roomId);
    const room = id === null ? undefined : getRoom(ctx.conn, id);
    if (!room) this.log?.warn(`conversation task ${ctx.task.id}: its room is gone; the reply is dropped`);
    return room ?? null;
  }

  done(ctx: ConversationSinkContext, result: ConversationResult): void {
    const room = this.roomOf(ctx);
    const recorded = this.capabilities?.takeActions(ctx.task.id) ?? [];
    if (!room) return;
    const now = this.now();
    if (result.kind === "chat") {
      const { cards, runRefs } = leadCards(recorded, result.output);
      postMessage(ctx.conn, { room, author: "lead", text: clip(result.output.reply, REPLY_TEXT_MAX), cards, runRefs }, now);
      return;
    }
    this.consultReply(ctx, room, result.output, now);
  }

  private consultReply(ctx: ConversationSinkContext, room: Room, output: ConsultOutput, now: Date): void {
    const bot = ctx.task.botName;
    const handoff = output.handoffToLead;
    const request = handoff ? clip(handoff.request, 2_000) : null;
    const handoffCard: MessageCard[] = request ? [{ type: "handoff", fromBot: bot, request }] : [];
    postMessage(ctx.conn, { room, author: bot, text: clip(output.reply, REPLY_TEXT_MAX), cards: handoffCard }, now);
    if (!request) return;
    // UC-25 a / rule 1: work is never done here; it goes to Lead, who plans it as in UC-01.
    const lead = getOrCreateLeadRoom(ctx.conn, { now });
    const note = postMessage(
      ctx.conn,
      { room: lead, author: "system", text: `Handed over from @${botLabel(bot)}: ${request}`, cards: handoffCard, meta: { handoffFrom: bot } },
      now,
    );
    const input = ctx.task.input as ConversationInputLike;
    const uploadIds = Array.isArray(input.uploadIds) ? input.uploadIds.filter((u): u is string => typeof u === "string") : [];
    try {
      // A savepoint: if Lead cannot take it (disabled), the rest of this reply still commits.
      ctx.conn.transaction(() => {
        ctx.enqueue({
          bot: "lead",
          kind: "chat",
          input: {
            roomId: String(lead.id),
            messageId: String(note.id),
            // Ba's own words (trusted); the bot's restatement goes in the untrusted handoff block.
            text: typeof input.text === "string" && input.text.trim() !== "" ? input.text : request,
            history: conversationHistory(ctx.conn, lead.id, note.id),
            uploadIds,
            handoff: { fromBot: bot, request },
          },
        });
      });
    } catch (err) {
      const why = err instanceof Error && /disabled/.test(err.message) ? "Lead is disabled on the Bots screen" : "Lead could not take it";
      postMessage(ctx.conn, { room: lead, author: "system", text: `The request from @${botLabel(bot)} was not planned: ${why}.` }, now);
    }
  }

  failed(ctx: ConversationSinkContext, _error: string): void {
    this.capabilities?.takeActions(ctx.task.id);
    const room = this.roomOf(ctx);
    if (!room) return;
    // The error may name paths or CLI output: Ba gets a plain note; the step drawer has the details.
    postMessage(
      ctx.conn,
      { room, author: ctx.task.botName, text: `${botLabel(ctx.task.botName)} could not answer this message (task ${ctx.task.id} failed). Try again in a moment.` },
      this.now(),
    );
  }
}
