// ITviec (design §5.2; records/itviec.json): no JSON API, so the guest search and job pages are read
// for their JSON-LD (json-ld-board.ts). A job page is /it-jobs/<slug>-<number>; the salary is in its
// JobPosting even for a guest.
import { scanJsonLdBoard, type JsonLdBoard } from "./json-ld-board.js";
import type { BoardMapper } from "./types.js";

export const ITVIEC_BOARD: JsonLdBoard = {
  source: "itviec",
  label: "ITviec",
  host: "itviec.com",
  isJobPath: (path) => /^\/it-jobs\/[^/]+-\d+$/.test(path),
};

export const itviecMapper: BoardMapper = {
  source: "itviec",
  scan: (client, input, signal) => scanJsonLdBoard(ITVIEC_BOARD, client, input, signal),
};
