// API research (design §5.2, §5.3): the engine's BoardScanPort. For one board scan it reads the
// board's credentials (account API only), builds the allowlisted BoardApiClient from the board's
// record and runs the board's mapper. A board with no configured credential throws
// MissingCredential before any client exists, so no request is sent. Every error leaving here is
// redacted.
import { sourceAccessRecord, type BoardSource, type ResearchScanInput, type SourceAccessRecord } from "@bs-job-agents/shared";
import type { BoardRequestRecord, BoardScanPort, SecretStore } from "../../engine/ports.js";
import type { HostGate, HttpFetch } from "../http/index.js";
import { Redactor } from "../secrets/redactor.js";
import { AuthRejected, BoardApiClient, BoardApiError, EndpointNotAllowed, MissingCredential } from "./client.js";
import { BOARD_MAPPERS } from "./mappers.js";
import type { BoardMapper } from "./types.js";

export interface BoardApiScannerOptions {
  fetch: HttpFetch;
  /** The process's per-host gate (shared with the feeds). */
  gate: HostGate;
  /** null: no secrets file (every account-API board misses its credential). */
  secrets: SecretStore | null;
  /** The secret store's redactor, so values read anywhere on this path are redacted. */
  redactor?: Redactor;
  mappers?: Partial<Record<BoardSource, BoardMapper>>;
  records?: (source: BoardSource) => SourceAccessRecord;
  timeoutMs?: number;
}

export class BoardApiScanner implements BoardScanPort {
  private readonly redactor: Redactor;
  private readonly mappers: Partial<Record<BoardSource, BoardMapper>>;
  private readonly records: (source: BoardSource) => SourceAccessRecord;

  constructor(private readonly opts: BoardApiScannerOptions) {
    this.redactor = opts.redactor ?? new Redactor();
    this.mappers = opts.mappers ?? BOARD_MAPPERS;
    this.records = opts.records ?? sourceAccessRecord;
  }

  record(source: BoardSource): SourceAccessRecord {
    return this.records(source);
  }

  canScan(source: BoardSource): boolean {
    return this.mappers[source] !== undefined;
  }

  hasCredentials(source: BoardSource): boolean {
    return this.opts.secrets?.has(source) ?? false;
  }

  redact(text: string): string {
    return this.redactor.redact(text);
  }

  async scan(
    source: BoardSource,
    req: { path: "public_api" | "account_api"; input: ResearchScanInput; signal?: AbortSignal; onRequest?: (r: BoardRequestRecord) => void },
  ): Promise<{ jobs: unknown[]; note?: string }> {
    const mapper = this.mappers[source];
    if (!mapper) throw new BoardApiError("failed", `no API reader for ${source}`);
    const record = this.records(source);
    const credentials = req.path === "account_api" ? (this.opts.secrets?.credentials(source) ?? null) : null;
    if (req.path === "account_api" && record.auth.kind !== "none" && credentials === null) throw new MissingCredential(source, record.auth.names);
    const client = new BoardApiClient({
      record,
      path: req.path,
      fetch: this.opts.fetch,
      gate: this.opts.gate,
      credentials,
      redactor: this.redactor,
      ...(req.onRequest ? { onRequest: req.onRequest } : {}),
      ...(this.opts.timeoutMs !== undefined ? { timeoutMs: this.opts.timeoutMs } : {}),
    });
    try {
      return await mapper.scan(client, req.input, req.signal);
    } catch (err) {
      // Their messages name the board, a host and a path only.
      if (err instanceof AuthRejected || err instanceof MissingCredential || err instanceof EndpointNotAllowed) throw err;
      if (err instanceof BoardApiError) throw new BoardApiError(err.kind, this.redact(err.message));
      if (req.signal?.aborted) throw err;
      // A mapper bug or an unexpected response shape: not retried, and never with a value in it.
      throw new BoardApiError("failed", this.redact(err instanceof Error ? err.message : String(err)));
    }
  }
}
