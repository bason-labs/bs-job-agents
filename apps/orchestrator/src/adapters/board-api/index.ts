// API research (AD-2, design §5.2): the allowlisted board-API client and the per-board mappers.
export {
  ApiChanged,
  AuthRejected,
  DirectReadBlocked,
  isBotCheckPage,
  BOARD_API_USER_AGENT,
  BoardApiClient,
  BoardApiError,
  EndpointNotAllowed,
  MAX_REDIRECTS,
  MissingCredential,
  RedirectRefused,
  matchesPathPattern,
  checkSearchBody,
  type BoardApiClientOptions,
  type BoardPostRequest,
  type BoardRequest,
  type RecordedRequest,
} from "./client.js";
export { BOARD_MAPPERS } from "./mappers.js";
export { BoardApiScanner, type BoardApiScannerOptions } from "./scanner.js";
export type { BoardMapper, BoardScanResult } from "./types.js";
