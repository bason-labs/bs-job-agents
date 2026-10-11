// PM2 S17: per-spawn capabilities for the orchestrator MCP server. Each Lead CLI spawn gets its own
// random token, minted just before the spawn and revoked when that spawn returns. The token is the
// only thing that maps an MCP request to its caller (`LeadCaller`: bot + chat mode), its task and
// the room it answers in, so a static URL can never tell callers apart or outlive its task.
// - 256 random bits, base64url; only its SHA-256 is kept (a heap dump or log shows no live token).
// - It expires with the task: revoked in the runner's `finally`, and a hard TTL (the task's timeout
//   plus a margin) covers a revoke that never ran. Each call also checks the task is still running.
import { createHash, randomBytes } from "node:crypto";
import type { ChatMode } from "@bs-job-agents/shared";
import type { LeadCaller } from "../engine/index.js";

export interface Capability {
  taskId: number;
  attempt: number;
  caller: LeadCaller;
  /** The room the conversation answers in (message_user posts there); null = the Lead chat. */
  roomId: number | null;
  /** Epoch ms. */
  expiresAt: number;
  /** message_user calls so far (capped per spawn). */
  messages: number;
  /** propose_workflow calls so far (capped per spawn). */
  proposals: number;
}

export interface MintInput {
  taskId: number;
  attempt: number;
  caller: LeadCaller;
  roomId: number | null;
  ttlMs: number;
}

/** What Lead did through its tools, kept per task so the chat shows the real delegation trace. */
export type LeadToolAction =
  | { type: "start_workflow"; workflow: string; runId: number }
  | { type: "create_task"; bot: string; kind: string; taskId: number }
  | { type: "propose_workflow"; proposalId: string; name: string };

/** A conversation task's chat mode: Lead's chat is work; consult and room replies never are (rule 1). */
export function chatModeOfKind(kind: string): ChatMode {
  if (kind === "chat") return "work";
  if (kind === "consult") return "consult";
  return "discussion";
}

const hash = (token: string): string => createHash("sha256").update(token).digest("hex");

export class CapabilityStore {
  private readonly live = new Map<string, Capability>();
  private readonly actions = new Map<number, LeadToolAction[]>();
  private readonly now: () => number;
  private readonly random: () => string;

  constructor(opts: { now?: () => number; random?: () => string } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.random = opts.random ?? (() => randomBytes(32).toString("base64url"));
  }

  /** A new token for one spawn. The caller keeps it secret and revokes it when the spawn ends. */
  mint(input: MintInput): string {
    const token = this.random();
    this.live.set(hash(token), {
      taskId: input.taskId,
      attempt: input.attempt,
      caller: { ...input.caller },
      roomId: input.roomId,
      expiresAt: this.now() + Math.max(0, input.ttlMs),
      messages: 0,
      proposals: 0,
    });
    return token;
  }

  /** The capability a token grants, or null (unknown, revoked or expired). */
  resolve(token: string): Capability | null {
    if (typeof token !== "string" || token.length < 16 || token.length > 128) return null;
    const key = hash(token);
    const cap = this.live.get(key);
    if (!cap) return null;
    if (this.now() >= cap.expiresAt) {
      this.live.delete(key);
      return null;
    }
    return cap;
  }

  revoke(token: string): void {
    this.live.delete(hash(token));
  }

  /** Live capabilities (tests, /status). Expired ones are dropped first. */
  size(): number {
    const now = this.now();
    for (const [key, cap] of this.live) if (now >= cap.expiresAt) this.live.delete(key);
    return this.live.size;
  }

  record(taskId: number, action: LeadToolAction): void {
    const list = this.actions.get(taskId) ?? [];
    list.push(action);
    this.actions.set(taskId, list);
  }

  /** The actions of one task (every attempt), removed from the log. */
  takeActions(taskId: number): LeadToolAction[] {
    const list = this.actions.get(taskId) ?? [];
    this.actions.delete(taskId);
    return list;
  }
}
