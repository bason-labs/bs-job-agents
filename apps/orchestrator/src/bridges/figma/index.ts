// Local Figma bridge (spec §4.2, §6.2; spike S3b): client, fingerprint, code guard, test fakes.
export {
  FigmaBridge,
  type FigmaBridgeOptions,
  type FigmaDraftsPage,
  type FigmaFrameInfo,
  type FigmaPdfExport,
  type WaitForConnectionOptions,
} from "./bridge.js";
export {
  DEFAULT_CV_FILE_KEY,
  DRAFTS_PAGE_NAME,
  FIGMA_CONSOLE_MCP_VERSION,
  FIGMA_EXECUTE_MAX_MS,
  KNOWN_PROTECTED_PAGES,
} from "./constants.js";
export { FigmaBridgeError, isFigmaUnavailable, type FigmaBridgeErrorCode } from "./errors.js";
export {
  buildFingerprint,
  canonicalJson,
  diffFingerprints,
  templatesFromFingerprint,
  type FigmaTemplate,
  type FingerprintChange,
  type FingerprintChangeKind,
  type FingerprintDiff,
  type FingerprintNode,
  type PageFingerprint,
  type PageSnapshot,
  type ProtectedPagesFingerprint,
} from "./fingerprint.js";
export {
  checkFigmaCode,
  DEFAULT_FIGMA_GUARD_POLICY,
  evaluateFigmaToolCall,
  FIGMA_GUARD_ALLOWED_TOOLS,
  figmaGuardPolicyFromFingerprint,
  type FigmaGuardPolicy,
  type FigmaToolGuardOptions,
} from "./guard.js";
export {
  buildFigmaGuardSettings,
  figmaGuardHookCommand,
  prepareFigmaGuard,
  readFigmaGuardConfig,
  writeFigmaGuardConfig,
  type FigmaGuardConfig,
  type FigmaGuardSettingsOptions,
  type PrepareFigmaGuardOptions,
} from "./guard-settings.js";
export {
  connectFigmaConsoleMcp,
  resolveFigmaConsoleMcp,
  type ConnectFigmaMcpOptions,
  type FigmaMcpClient,
  type McpToolResult,
} from "./mcp.js";
export type { FigmaConnectedFile, FigmaConnectionState, FigmaStatus } from "./replies.js";
// Test support for engine tests (W2a): scripted or document-backed fake bridge.
export { FakeFigmaMcp, type FakeExecuteHandler, type FakeFigmaFile, type FakeFigmaMcpOptions } from "./fake-bridge.js";
export { FakeFigmaApi, runPluginCode, type FakeFigmaApiInit, type FakeNodeInit } from "./fake-figma-api.js";
