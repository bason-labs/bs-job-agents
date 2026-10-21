// The board mappers (one <source>.ts per board read through an API, tested against the scrubbed
// responses in fixtures/<source>/). A board whose path is an API but has no mapper here is scanned
// in the browser: LinkedIn (its endpoints are unverified and need Ba's approval), and every board
// whose record finds no usable GET endpoint (VietnamWorks, Wellfound, Upwork).
import type { BoardSource } from "@bs-job-agents/shared";
import { itviecMapper } from "./itviec.js";
import { topcvMapper } from "./topcv.js";
import type { BoardMapper } from "./types.js";

export const BOARD_MAPPERS: Partial<Record<BoardSource, BoardMapper>> = {
  topcv: topcvMapper,
  itviec: itviecMapper,
};
