// API research (AD-3, design §5.1): the one place the orchestrator decides how a source is read.
// The queue's routing (task-factory, api-tasks) and the Search criteria route both call
// sourceAccess, which applies the shared accessStateOf to the board's record, Ba's approval
// (bound to the record's researchedAt) and whether its credentials are configured. A board whose
// path is an API but has no mapper yet stays on the browser.
import { accessStateOf, isBoardSource, isFeedSource, type AccessState, type SourceAccessRecord } from "@bs-job-agents/shared";
import { isSourceApproved, type Conn } from "../db/index.js";
import type { BoardScanPort } from "./ports.js";

export interface SourceAccess extends AccessState {
  /** null for the feed boards (public_api by construction) and unknown sources. */
  record: SourceAccessRecord | null;
}

const PUBLIC: AccessState = { path: "public_api", needsApproval: false, tokenMissing: false, labelKey: "public_api" };
const BROWSER: AccessState = { path: "browser", needsApproval: false, tokenMissing: false, labelKey: "browser" };

export function sourceAccess(conn: Conn, boards: BoardScanPort | undefined, source: string): SourceAccess {
  if (isFeedSource(source)) return { ...PUBLIC, record: null };
  if (!isBoardSource(source) || !boards) return { ...BROWSER, record: null };
  const record = boards.record(source);
  if (!boards.canScan(source)) return { ...BROWSER, record };
  const approved = isSourceApproved(conn, source, record.researchedAt);
  return { ...accessStateOf(record, { approved, tokenPresent: boards.hasCredentials(source) }), record };
}
