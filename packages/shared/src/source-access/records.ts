// The six browser boards' access records (design §5.1). The four feed boards need none: they are
// public_api by construction (src/common/sources.ts kind "feed").
import type { SearchSource } from "../common/primitives.js";
import { isFeedSource } from "../common/sources.js";
import { RESEARCHED_RECORDS } from "./researched.js";
import { NONE_FOUND, SourceAccessRecordSchema, accessPathOf, type AccessPath, type SourceAccessRecord } from "./schema.js";

export const BOARD_SOURCES = ["topcv", "itviec", "vietnamworks", "linkedin", "wellfound", "upwork"] as const satisfies readonly SearchSource[];
export type BoardSource = (typeof BOARD_SOURCES)[number];

/**
 * The boards the orchestrator has an API reader for (apps/orchestrator board-api BOARD_MAPPERS; a
 * test there keeps the two equal). Any other board is read in the browser whatever its record says,
 * so it has nothing to approve. The web's mock orchestrator follows the same rule.
 */
export const API_READER_BOARDS = ["topcv", "itviec"] as const satisfies readonly BoardSource[];

export function isBoardSource(source: unknown): source is BoardSource {
  return typeof source === "string" && (BOARD_SOURCES as readonly string[]).includes(source);
}

/** A board nobody researched yet: nothing found, nothing documented, so it is read in the browser. */
export function unresearchedRecord(source: BoardSource): SourceAccessRecord {
  return {
    source,
    researchedAt: "unresearched",
    publicApi: NONE_FOUND,
    internalApiGetEndpoints: NONE_FOUND,
    applyEndpoints: NONE_FOUND,
    auth: { kind: "none", names: [], howToCopy: "" },
    termsOfUse: { url: "", clauses: [] },
    accountRisk: "",
    riskLevel: "high",
    chosenPath: "browser",
  };
}

const RECORDS: Record<BoardSource, SourceAccessRecord> = Object.fromEntries(
  BOARD_SOURCES.map((source) => {
    const raw = RESEARCHED_RECORDS[source];
    if (raw === undefined) return [source, unresearchedRecord(source)];
    const parsed = SourceAccessRecordSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`source-access/records/${source}.json is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    if (parsed.data.source !== source) throw new Error(`source-access/records/${source}.json names source ${parsed.data.source}`);
    return [source, parsed.data];
  }),
) as Record<BoardSource, SourceAccessRecord>;

export function sourceAccessRecord(source: BoardSource): SourceAccessRecord {
  return RECORDS[source];
}

export function sourceAccessRecords(): SourceAccessRecord[] {
  return BOARD_SOURCES.map((s) => RECORDS[s]);
}

/** Any search source's path: feeds are public_api; a board follows its record and Ba's approval. */
export function accessPathOfSource(source: SearchSource, opts: { approved: boolean }): AccessPath {
  if (isFeedSource(source)) return "public_api";
  return isBoardSource(source) ? accessPathOf(RECORDS[source], opts) : "browser";
}
