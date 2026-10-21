// API research (design §5.2): one mapper per board read through an API. It asks the client for the
// board's search (and, when the list gives a snippet, detail) responses and turns them into
// research.scan jobs. A mapper never calls fetch: the client enforces the record's endpoints, the
// per-host gap and the credentials. Its jobs then go through settleScanOutput (engine/scan-settle.ts):
// each posting is validated alone (an invalid one is dropped), "full JD text" is checked, then the
// scan checker and the scan's dedupe step.
import type { BoardSource, JobCandidate, ResearchScanInput } from "@bs-job-agents/shared";
import type { BoardApiClient } from "./client.js";

export interface BoardScanResult {
  /** JobCandidate-shaped postings (source = the board, url = the posting's page on the board, full jdText). */
  jobs: JobCandidate[];
  /** One line for the scan's self-check note, e.g. "2 search pages, 14 postings, 9 detail pages". */
  note?: string;
}

export interface BoardMapper {
  source: BoardSource;
  /** Redirect hops the board's client may follow (default MAX_REDIRECTS; LinkedIn 0: any 3xx is refused). */
  maxRedirects?: number;
  /**
   * One scan: `input.criteria` is the Search Profile and `input.candidateLimit` the most postings to
   * return. Throws what the client throws (EndpointNotAllowed, MissingCredential, AuthRejected,
   * BoardApiError); `signal` is the task's cancel.
   */
  scan(client: BoardApiClient, input: ResearchScanInput, signal?: AbortSignal): Promise<BoardScanResult>;
}
