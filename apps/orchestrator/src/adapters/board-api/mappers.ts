// The board mappers (one <source>.ts per board read through an API, tested against the scrubbed
// responses in fixtures/<source>/). A board whose path is an API but has no mapper here is scanned
// in the browser.
import type { BoardSource } from "@bs-job-agents/shared";
import type { BoardMapper } from "./types.js";

export const BOARD_MAPPERS: Partial<Record<BoardSource, BoardMapper>> = {};
