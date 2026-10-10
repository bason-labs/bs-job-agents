// Typed failures of the Figma bridge. `not_connected` and `server_unavailable` mean the task
// should wait as `needs_figma` (UC-17); the rest are failures of the call itself.

export type FigmaBridgeErrorCode =
  /** Figma desktop or the Desktop Bridge plugin is not reachable (or not in the CV file). */
  | "not_connected"
  /** The local figma-console-mcp process could not start or died. */
  | "server_unavailable"
  /** The plugin call ran past its time limit (it may still finish inside Figma). */
  | "timeout"
  | "syntax_error"
  /** The plugin code threw. */
  | "plugin_error"
  | "bad_reply"
  /** The call ran in another Figma file than the CV file. */
  | "wrong_file"
  | "invalid_argument"
  | "not_found"
  | "not_a_frame"
  | "not_in_drafts"
  | "frame_hidden"
  | "name_taken"
  | "no_drafts_page"
  | "export_failed";

export class FigmaBridgeError extends Error {
  override readonly name = "FigmaBridgeError";
  constructor(
    readonly code: FigmaBridgeErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Errors after which a CV task should pause as `needs_figma` instead of failing. */
export function isFigmaUnavailable(err: unknown): boolean {
  return err instanceof FigmaBridgeError && (err.code === "not_connected" || err.code === "server_unavailable");
}
