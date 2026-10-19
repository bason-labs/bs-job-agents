// TopCV (design §5.2; records/topcv.json): no JSON API, so the guest search and job pages are read
// for their JSON-LD (json-ld-board.ts). Job pages on /brand/… are not in the record: skipped.
import { scanJsonLdBoard, type JsonLdBoard } from "./json-ld-board.js";
import type { BoardMapper } from "./types.js";

export const TOPCV_BOARD: JsonLdBoard = {
  source: "topcv",
  label: "TopCV",
  host: "www.topcv.vn",
  isJobPath: (path) => /^\/viec-lam\/[^/]+\/\d+\.html$/.test(path),
};

export const topcvMapper: BoardMapper = {
  source: "topcv",
  scan: (client, input, signal) => scanJsonLdBoard(TOPCV_BOARD, client, input, signal),
};
