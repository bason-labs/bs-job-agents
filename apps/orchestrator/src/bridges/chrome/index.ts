// Ba's real Chrome (spec §4.4): site guard hook and the browser bridge check.
export * from "./site-guard/index.js";
export {
  browserReadyFor,
  checkBrowserBridge,
  defaultBrowserProbes,
  NATIVE_HOSTS,
  nativeHostManifestPath,
  type BrowserBridgeStatus,
  type BrowserNotReadyReason,
  type BrowserProbes,
  type CheckBrowserBridgeOptions,
  type EngineBrowserStatus,
  type NativeHostStatus,
} from "./status.js";
