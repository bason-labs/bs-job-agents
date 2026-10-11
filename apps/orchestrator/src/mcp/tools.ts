// The orchestrator MCP server's six tools (spec §3 rule 5, §5.2 Lead; PM2 S17). They are Lead's
// only tools: they divide work and never do it.
// - start_workflow, create_task, get_status, get_result → engine.lead (research.* tasks only; an
//   outward-facing task or a call from consult/room mode is refused there, with a safety event).
// - message_user → a Lead message in the room the conversation came from (capped per spawn).
// - propose_workflow → kept for Ba (rule 3); never saved as a workflow or run until he approves.
// There is no tool that answers Apply's questions or approves anything: those are Ba's (UC-08, UC-12).
import { getOrCreateLeadRoom, getRoom, getTask } from "../db/index.js";
import { EngineError, type Engine } from "../engine/index.js";
import { ApiHttpError } from "../api/errors.js";
import type { ProposalStore } from "../api/proposals.js";
import { REPLY_TEXT_MAX, clip, postMessage } from "../api/chat/messages.js";
import type { CapabilityStore, Capability } from "./capabilities.js";

export const ORCHESTRATOR_TOOLS = ["start_workflow", "create_task", "get_status", "get_result", "message_user", "propose_workflow"] as const;
export type OrchestratorTool = (typeof ORCHESTRATOR_TOOLS)[number];

/** message_user calls per spawn: progress notes, not a stream. */
export const MESSAGE_USER_CAP = 5;
/** propose_workflow calls per spawn. */
export const PROPOSE_WORKFLOW_CAP = 2;

export interface ToolDefinition {
  name: OrchestratorTool;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
}

const idString = { type: "string", description: "A numeric id, e.g. \"12\"" };

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "start_workflow",
    description:
      "Start a named workflow: job-scan (find jobs; params {searchProfileId: null, overrides: null | {...}}), apply-to-link (params {url, applyAgain: false}) or apply-to-file (params {uploadId}). Returns {started, runId} or {started: false, reason: \"already_applied\"}.",
    inputSchema: {
      type: "object",
      properties: { workflow: { type: "string", enum: ["job-scan", "apply-to-link", "apply-to-file"] }, params: { type: "object" } },
      required: ["workflow", "params"],
      additionalProperties: false,
    },
  },
  {
    name: "create_task",
    description: "Create one standalone Research task (research.scan, research.single, research.file, research.fit, research.company). Every other bot's work runs inside a workflow.",
    inputSchema: {
      type: "object",
      properties: { bot: { type: "string", enum: ["research"] }, kind: { type: "string", enum: ["scan", "single", "file", "fit", "company"] }, input: { type: "object" } },
      required: ["bot", "kind", "input"],
      additionalProperties: false,
    },
  },
  {
    name: "get_status",
    description: "Active runs (or one run by runId) with their steps and tasks, engine usage pauses and tasks waiting for Ba.",
    inputSchema: { type: "object", properties: { runId: idString }, additionalProperties: false },
  },
  {
    name: "get_result",
    description: "A task's status and, once done, its output.",
    inputSchema: { type: "object", properties: { taskId: idString }, required: ["taskId"], additionalProperties: false },
  },
  {
    name: "message_user",
    description: `Post a short message to Ba in this chat while you work (at most ${MESSAGE_USER_CAP} per reply). Your final answer goes in your output's reply, not here.`,
    inputSchema: { type: "object", properties: { text: { type: "string", minLength: 1, maxLength: REPLY_TEXT_MAX } }, required: ["text"], additionalProperties: false },
  },
  {
    name: "propose_workflow",
    description:
      "Suggest saving a repeated request as a workflow (rule 3). Either {name, description, basedOn: \"job-scan\" | \"apply-to-link\" | \"apply-to-file\", params} for a preset, or {name, description, definitionYaml}. Ba approves or dismisses it; nothing runs.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
        description: { type: "string" },
        basedOn: { type: ["string", "null"], enum: ["job-scan", "apply-to-link", "apply-to-file", null] },
        params: { type: ["object", "null"] },
        definitionYaml: { type: ["string", "null"] },
      },
      required: ["name", "description"],
      additionalProperties: false,
    },
  },
];

export interface ToolDeps {
  engine: Engine;
  proposals: ProposalStore;
  capabilities: CapabilityStore;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** A refusal the model sees as a tool error (its message never names internals). */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

const ok = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const fail = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });

/** Only a Lead in the Lead chat (work mode) may message Ba or propose (rule 1); engine tools check it too. */
function assertWork(deps: ToolDeps, cap: Capability, action: string): void {
  if (cap.caller.botName === "lead" && cap.caller.mode === "work") return;
  // The engine's check emits the safety event and throws the refusal.
  deps.engine.lead.getStatus(cap.caller, {});
  throw new ToolError(`only Lead, in the Lead chat, can ${action}`);
}

function messageUser(deps: ToolDeps, cap: Capability, raw: unknown): unknown {
  assertWork(deps, cap, "message_user");
  const text = (raw as { text?: unknown } | null)?.text;
  if (typeof text !== "string" || text.trim() === "") throw new ToolError("message_user needs { text }");
  if (cap.messages >= MESSAGE_USER_CAP) throw new ToolError(`message_user is limited to ${MESSAGE_USER_CAP} messages per reply; put the rest in your reply`);
  const engine = deps.engine;
  const message = engine.db.transaction((tx) => {
    const room = (cap.roomId !== null ? getRoom(tx, cap.roomId) : undefined) ?? getOrCreateLeadRoom(tx, { now: engine.now() });
    return postMessage(tx, { room, author: "lead", text: clip(text.trim(), REPLY_TEXT_MAX) }, engine.now());
  });
  engine.bus.flush();
  cap.messages++;
  return { posted: true, messageId: String(message.id) };
}

function proposeWorkflow(deps: ToolDeps, cap: Capability, raw: unknown): unknown {
  assertWork(deps, cap, "propose_workflow");
  if (cap.proposals >= PROPOSE_WORKFLOW_CAP) throw new ToolError(`propose_workflow is limited to ${PROPOSE_WORKFLOW_CAP} proposals per reply`);
  const proposal = deps.proposals.propose(raw, { taskId: cap.taskId });
  cap.proposals++;
  deps.capabilities.record(cap.taskId, { type: "propose_workflow", proposalId: proposal.id, name: proposal.name });
  return { proposed: true, proposalId: proposal.id, status: proposal.status, note: "Ba approves or dismisses it on the Flows screen; nothing runs until then." };
}

function errorText(err: unknown): string {
  // Refusals written for Ba (EngineError, ApiHttpError) are safe to show; anything else may name SQL or a path.
  if (err instanceof ToolError || err instanceof EngineError || err instanceof ApiHttpError) return err.message;
  return "the orchestrator could not run this tool";
}

/** Run one tool for one capability. Never throws: errors are tool results the model can read. */
export function callTool(deps: ToolDeps, cap: Capability, name: string, args: unknown): ToolResult {
  const task = getTask(deps.engine.db, cap.taskId);
  if (!task || task.status !== "running") return fail("this conversation's task is no longer running");
  const lead = deps.engine.lead;
  try {
    switch (name as OrchestratorTool) {
      case "start_workflow": {
        const r = lead.startWorkflow(cap.caller, args);
        if (r.started) {
          const workflow = String((args as { workflow?: unknown }).workflow);
          deps.capabilities.record(cap.taskId, { type: "start_workflow", workflow, runId: r.runId });
          return ok({ started: true, runId: String(r.runId) });
        }
        return ok({ started: false, reason: r.reason, applicationId: String(r.applicationId) });
      }
      case "create_task": {
        const r = lead.createTask(cap.caller, args);
        const a = args as { bot: string; kind: string };
        deps.capabilities.record(cap.taskId, { type: "create_task", bot: a.bot, kind: a.kind, taskId: r.taskId });
        return ok({ taskId: String(r.taskId) });
      }
      case "get_status":
        return ok(lead.getStatus(cap.caller, args ?? {}));
      case "get_result":
        return ok(lead.getResult(cap.caller, args));
      case "message_user":
        return ok(messageUser(deps, cap, args));
      case "propose_workflow":
        return ok(proposeWorkflow(deps, cap, args));
      default:
        return fail(`unknown tool ${String(name).slice(0, 60)}`);
    }
  } catch (err) {
    return fail(errorText(err));
  }
}
