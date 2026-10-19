// The seam where the researcher's records are wired in (design §5.5): one entry per board from
// ./records/<source>.json. A board left out here is read in the browser (records.ts fills in an
// "unresearched" record). records.ts validates each one against SourceAccessRecordSchema at load.
import type { BoardSource } from "./records.js";
import itviec from "./records/itviec.json" with { type: "json" };
import linkedin from "./records/linkedin.json" with { type: "json" };
import topcv from "./records/topcv.json" with { type: "json" };
import upwork from "./records/upwork.json" with { type: "json" };
import vietnamworks from "./records/vietnamworks.json" with { type: "json" };
import wellfound from "./records/wellfound.json" with { type: "json" };

export const RESEARCHED_RECORDS: Partial<Record<BoardSource, unknown>> = { topcv, itviec, vietnamworks, linkedin, wellfound, upwork };
