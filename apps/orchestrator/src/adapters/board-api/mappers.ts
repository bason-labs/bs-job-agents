// The board mappers (one <source>.ts per board read through an API, tested against the scrubbed
// responses in fixtures/<source>/). A board whose path is an API but has no mapper here is scanned
// in the browser: every board whose record finds no usable endpoint (Wellfound, Upwork). LinkedIn
// has a reader but its record is high risk, so it stays in the browser until Ba approves it.
import type { BoardSource } from "@bs-job-agents/shared";
import { itviecMapper } from "./itviec.js";
import { linkedinMapper } from "./linkedin.js";
import { topcvMapper } from "./topcv.js";
import type { BoardMapper } from "./types.js";
import { vietnamworksMapper } from "./vietnamworks.js";

export const BOARD_MAPPERS: Partial<Record<BoardSource, BoardMapper>> = {
  topcv: topcvMapper,
  itviec: itviecMapper,
  vietnamworks: vietnamworksMapper,
  linkedin: linkedinMapper,
};
