// The seam where the researcher's records are wired in (design §5.5): one entry per board from
// ./records/<source>.json, e.g.
//   import linkedin from "./records/linkedin.json" with { type: "json" };
//   export const RESEARCHED_RECORDS = { linkedin };
// A board left out here is read in the browser (records.ts fills in an "unresearched" record).
import type { BoardSource } from "./records.js";

export const RESEARCHED_RECORDS: Partial<Record<BoardSource, unknown>> = {};
