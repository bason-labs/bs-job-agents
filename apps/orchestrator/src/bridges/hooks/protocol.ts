// Claude Code PreToolUse hook protocol, as used by the site guard and the Figma guard.
// The hook gets one JSON object on stdin. Exit 0 lets the tool run; exit 2 blocks it and
// stderr goes back to the model. Any other exit code is a non-blocking error (the tool runs),
// so every guard here fails closed by mapping its own failures to exit 2.
import { z } from "zod";

export const PreToolUseInputSchema = z
  .object({
    hook_event_name: z.string().optional(),
    tool_name: z.string().min(1),
    tool_input: z.unknown().optional(),
    session_id: z.string().optional(),
    tool_use_id: z.string().optional(),
    cwd: z.string().optional(),
  })
  .passthrough();

export interface PreToolUseCall {
  toolName: string;
  /** The tool's arguments; `{}` when the input carried something that is not an object. */
  toolInput: Record<string, unknown>;
  sessionId?: string;
  toolUseId?: string;
}

export type GuardDecision =
  | { allow: true }
  | {
      allow: false;
      /** Stable rule id for logs and tests, e.g. `navigate_host`, `figma_page_name`. */
      rule: string;
      /** Message for the model; it explains what was blocked and what to do instead. */
      reason: string;
      /** What the call tried to reach (URL, host, page), when known. */
      target?: string;
    };

export const ALLOW: GuardDecision = { allow: true };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
