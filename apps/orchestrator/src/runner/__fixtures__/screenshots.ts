// PM2 S7: stream-json lines of a Claude in Chrome session that takes screenshots.
// SYNTHETIC: the shape of an MCP tool result as Claude Code 2.1.296 prints it (claude/
// mcp-and-hook-denied.jsonl: `message.content[].content` and the mirrored `tool_use_result`) with
// the `computer` tool's screenshot reply (a text block "… - ID: ss_…" and an image block). The
// live capture that confirms it is recorded in docs/superpowers/build/reports/phase3-f3-fixer.md.

/** The smallest byte strings with real PNG / JPEG headers (enough for the magic-byte check). */
export const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4]);
export const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 5, 6, 7, 8]);

export interface FakeShot {
  toolUseId: string;
  /** Default mcp__claude-in-chrome__computer. */
  tool?: string;
  /** The id the tool shows, e.g. ss_7816fhx3w; null = no text block. */
  screenshotId: string | null;
  bytes: Buffer;
  /** What the block claims; default from the bytes. */
  mediaType?: string;
}

const CHROME = "mcp__claude-in-chrome__";

function assistantToolUse(id: string, name: string, input: unknown): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
    parent_tool_use_id: null,
    session_id: "s7-session",
  });
}

function userToolResult(id: string, content: unknown[]): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content }] },
    parent_tool_use_id: null,
    session_id: "s7-session",
    tool_use_result: content,
    tool_result_meta: [{ id, permission_decision: { decision: "accept", source: "config", reason_type: "rule" } }],
  });
}

/** One screenshot call and its reply. */
export function screenshotLines(shot: FakeShot): string[] {
  const tool = shot.tool ?? `${CHROME}computer`;
  const mediaType = shot.mediaType ?? (shot.bytes[0] === 0x89 ? "image/png" : "image/jpeg");
  const content: unknown[] = [];
  if (shot.screenshotId !== null) {
    content.push({ type: "text", text: `Successfully captured screenshot (1280x720, ${mediaType.slice(6)}) - ID: ${shot.screenshotId}` });
  }
  content.push({ type: "image", source: { type: "base64", media_type: mediaType, data: shot.bytes.toString("base64") } });
  return [assistantToolUse(shot.toolUseId, tool, { action: "screenshot", tabId: 1 }), userToolResult(shot.toolUseId, content)];
}

/** A navigate call and its reply (the page URL the tool reports). */
export function navigateLines(id: string, url: string, finalUrl = url): string[] {
  return [
    assistantToolUse(id, `${CHROME}navigate`, { url, tabId: 1 }),
    userToolResult(id, [{ type: "text", text: `Navigated to ${finalUrl}` }]),
  ];
}
