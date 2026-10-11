// Job source adapters (spec §12, UC-03/04). Owned by W4a in Phase 4.
// PM3 S8: production wiring (engine/wiring.ts) takes the scan-output checker from here. Until W4a
// implements the source-specific checks (required fields, plausibility, layout-change detection,
// LinkedIn's limits), every output that passed its schema and self-check is accepted.
import { acceptAllScanOutputChecker, type ScanOutputChecker } from "../engine/scan-check.js";

export function createScanOutputChecker(): ScanOutputChecker {
  return acceptAllScanOutputChecker;
}
