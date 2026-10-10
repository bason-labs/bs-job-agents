// Manual LIVE check, not part of the test suite:
//   pnpm --filter @bs-job-agents/orchestrator bridges:live-check
// Needs Figma desktop with the CV file open and the Desktop Bridge plugin running; otherwise it
// reports "not connected" and stops. It never changes Figma or Chrome: it fingerprints the
// protected pages, exports the Drafts frame SPIKE_TEST_EN_v1 to a temp PDF, prints its info,
// SHA-256 and the start of its text, then fingerprints again to show nothing changed.
// Env: LIVE_CHECK_FRAME (default SPIKE_TEST_EN_v1), LIVE_CHECK_WAIT_MS (default 20000).
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBrowserBridge } from "./chrome/status.js";
import { FigmaBridge } from "./figma/bridge.js";
import { diffFingerprints, templatesFromFingerprint } from "./figma/fingerprint.js";
import { extractText } from "./pdf/text.js";

const FRAME = process.env.LIVE_CHECK_FRAME ?? "SPIKE_TEST_EN_v1";
const WAIT_MS = Number(process.env.LIVE_CHECK_WAIT_MS ?? 20_000);

const say = (line = "") => process.stdout.write(`${line}\n`);

async function main(): Promise<number> {
  say("== bridges live check ==");
  // Process list and native-host manifests only; Chrome itself is not touched.
  const browser = await checkBrowserBridge();
  say(`chrome running: ${browser.chromeRunning}`);
  say(`  claude: ${browser.engines.claude.message}`);
  say(`  codex:  ${browser.engines.codex.message}`);

  const bridge = new FigmaBridge();
  try {
    say(`figma: starting figma-console-mcp, waiting up to ${WAIT_MS / 1000} s for the Desktop Bridge plugin…`);
    const t0 = Date.now();
    const status = await bridge.waitForConnection({ timeoutMs: WAIT_MS, initialDelayMs: 1000, maxDelayMs: 3000 });
    say(`figma: ${status.state} after ${Date.now() - t0} ms: ${status.message}`);
    if (!status.connected) {
      say("Figma is not connected, so there is nothing else to check.");
      return 0;
    }
    say(`file: "${status.fileName}" (${status.fileKey}), probe latency ${status.latencyMs} ms`);

    let t = Date.now();
    const before = await bridge.fingerprintProtectedPages();
    say(`fingerprint before (${Date.now() - t} ms): ${before.hash}`);
    for (const page of before.pages) say(`  page "${page.name}" (${page.id}): ${page.nodeCount} nodes, ${page.hash.slice(0, 12)}…`);
    say(`  styles/variables: ${before.resourcesError ? `unreadable (${before.resourcesError})` : (before.resourcesHash ?? "").slice(0, 12) + "…"}`);
    const templates = templatesFromFingerprint(before);
    say(`templates (A4 frames on protected pages): ${templates.length}`);
    for (const tpl of templates) say(`  ${tpl.id} "${tpl.name}" on ${tpl.pageName}${tpl.sectionName ? ` / ${tpl.sectionName}` : ""}`);

    const frame = await bridge.findDraftFrame(FRAME);
    if (!frame) {
      say(`no frame named ${FRAME} on the Drafts page: export skipped`);
    } else {
      const out = join(await mkdtemp(join(tmpdir(), "bridges-live-check-")), `${FRAME}.pdf`);
      t = Date.now();
      const pdf = await bridge.exportFramePdf(frame.id, out);
      say(`export of ${frame.id} "${pdf.frameName}" (${Date.now() - t} ms): ${pdf.path}`);
      say(`pdfInfo: ${pdf.pageCount} page(s), ${pdf.widthPt}×${pdf.heightPt} pt, one-page A4: ${pdf.onePageA4}, ${pdf.bytes} bytes`);
      say(`sha256: ${pdf.sha256}`);
      const text = await extractText(pdf.path);
      say(`text, first 200 chars: ${JSON.stringify(text.text.slice(0, 200))}`);
      const split = /\b(wit h|per formance)\b/.test(text.text);
      say(`word-split check: ${split ? "FALSE SPLITS FOUND" : "no 'wit h' / 'per formance' splits"}${text.text.includes("with performance") ? ' ("with performance" intact)' : ""}`);
    }

    t = Date.now();
    const after = await bridge.fingerprintProtectedPages();
    const diff = diffFingerprints(before, after);
    say(`fingerprint after (${Date.now() - t} ms): ${after.hash}`);
    say(`protected pages: ${diff.summary}`);
    return diff.changed ? 1 : 0;
  } finally {
    await bridge.stop();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`live check failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  },
);
