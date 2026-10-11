// Manual LIVE check (PM2 S7 / S27, pm-phase-3 §8 checks 2–3), not part of the test suite:
//   pnpm --filter @bs-job-agents/orchestrator live:screenshot
// Needs Chrome running with Claude in Chrome connected. It opens ONE new tab in the session's own
// tab group, goes to https://example.com (the site guard allows example.com only), takes one
// screenshot, closes the tab and lists what is left in the group. It never types, clicks or
// submits anything, and touches no other site.
// Every stdout line goes through the runner's own ScreenshotCapture, exactly as in a real Apply
// task, so the check shows: the image block's real shape, the file written to the capture folder
// with its manifest, and a transcript that holds a file reference instead of base64.
// Env: CLAUDE_BIN (default ~/.local/bin/claude), LIVE_CHECK_MODEL (default haiku).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { checkBrowserBridge } from "../src/bridges/chrome/status.js";
import { buildSiteGuardSettings } from "../src/bridges/chrome/site-guard/settings.js";
import { SCREENSHOT_MANIFEST, ScreenshotCapture } from "../src/runner/screenshots.js";
import { CLAUDE_CHROME_TOOLS } from "../src/runner/tools.js";

const CLAUDE = process.env.CLAUDE_BIN ?? join(homedir(), ".local", "bin", "claude");
const SITE = "example.com";
const say = (line = "") => process.stdout.write(`${line}\n`);
const chrome = (t: string) => `mcp__claude-in-chrome__${t}`;

const PROMPT = [
  `1. Call ${chrome("tabs_context_mcp")} with createIfEmpty true.`,
  `2. Call ${chrome("tabs_create_mcp")} to open ONE new tab.`,
  `3. Call ${chrome("navigate")} on that new tab to https://${SITE}/ .`,
  `4. Call ${chrome("computer")} with action "screenshot" on that tab (do not use save_to_disk).`,
  `5. Close every tab in your group with ${chrome("tabs_close_mcp")}, including an empty New Tab.`,
  `6. Call ${chrome("tabs_context_mcp")} again.`,
  "Reply with one line: SCREENSHOT <the screenshot id the tool showed, or none> LEFT <number of tabs still in your group>.",
  "Never click, type, scroll or open any other site.",
].join("\n");

/** The keys (and sizes) of the first image block in a raw stream line, for the fixture comparison. */
function imageShape(line: string): string | null {
  if (!line.includes('"image"')) return null;
  const found: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o.type === "image") {
        const describe = (x: unknown): unknown =>
          typeof x === "string" ? (x.length > 80 ? `<${x.length} chars>` : x) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, describe(y)])) : x;
        found.push(`${path}: ${JSON.stringify(describe(o))}`);
      }
      for (const [k, x] of Object.entries(o)) walk(x, `${path}.${k}`);
    }
  };
  try {
    walk(JSON.parse(line), "$");
  } catch {
    return null;
  }
  return found.length ? found.join("\n  ") : null;
}

async function main(): Promise<number> {
  say("== screenshot capture live check (S7) ==");
  const browser = await checkBrowserBridge();
  say(`chrome running: ${browser.chromeRunning}; claude: ${browser.engines.claude.message}`);
  if (!browser.chromeRunning) return 2;

  const root = mkdtempSync(join(tmpdir(), "bsja-live-shot-"));
  const shots = join(root, "screenshots", "1-1");
  const guardLog = join(root, "site-guard.jsonl");
  const transcript = join(root, "transcript.jsonl");
  const raw = join(root, "raw-image-lines.txt");
  const settings = buildSiteGuardSettings({ allowedSites: [SITE], logFile: guardLog });
  const allowed = ["tabs_context_mcp", "tabs_create_mcp", "navigate", "computer", "tabs_close_mcp"].map(chrome);
  const args = [
    "-p",
    PROMPT,
    "--chrome",
    "--setting-sources",
    "",
    // As the runner: no MCP server but Claude in Chrome (claude.ai connectors stay out).
    "--strict-mcp-config",
    "--tools",
    "",
    "--allowedTools",
    ...allowed,
    // Hide every other Chrome tool, as the runner does; otherwise the model picks browser_batch and is denied.
    "--disallowedTools",
    ...CLAUDE_CHROME_TOOLS.map(chrome).filter((t) => !allowed.includes(t)),
    "--settings",
    JSON.stringify(settings),
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--permission-prompts",
    "none",
    "--model",
    process.env.LIVE_CHECK_MODEL ?? "haiku",
  ];
  say(`folder: ${root}`);
  const capture = await ScreenshotCapture.open(shots);
  const child = spawn(CLAUDE, args, { stdio: ["ignore", "pipe", "pipe"] });
  const out: string[] = [];
  const shapes: string[] = [];
  let result = "";
  for await (const line of createInterface({ input: child.stdout })) {
    const shape = imageShape(line);
    if (shape) shapes.push(shape);
    const kept = capture.process(line);
    out.push(kept);
    try {
      const e = JSON.parse(line) as { type?: string; result?: string; message?: { content?: { type: string; name?: string; input?: unknown }[] } };
      if (e.type === "assistant") for (const c of e.message?.content ?? []) if (c.type === "tool_use") say(`tool: ${c.name} ${JSON.stringify(c.input).slice(0, 120)}`);
      if (e.type === "result") result = e.result ?? "";
    } catch {
      // not JSON
    }
  }
  await new Promise((resolve) => child.on("close", resolve));
  await capture.finish();
  writeFileSync(transcript, `${out.join("\n")}\n`);
  writeFileSync(raw, `${shapes.join("\n")}\n`);

  say(`result: ${result.trim()}`);
  say(`image blocks seen: ${shapes.length}`);
  for (const s of shapes) say(`  ${s}`);
  const manifest = join(shots, SCREENSHOT_MANIFEST);
  say(`manifest: ${existsSync(manifest) ? manifest : "MISSING"}`);
  for (const c of capture.captured) say(`  captured ${c.file}: ${c.mediaType}, ${c.bytes} bytes, id ${c.screenshotId ?? "none"}, tool ${c.tool}`);
  const base64Left = /"data":"[A-Za-z0-9+/=]{1000,}/.test(readFileSync(transcript, "utf8"));
  say(`transcript keeps base64: ${base64Left ? "YES (defect)" : "no (file references only)"}`);
  say(`site guard log: ${existsSync(guardLog) ? readFileSync(guardLog, "utf8").trim().split("\n").length + " decisions" : "none"}`);
  const ok = capture.captured.length >= 1 && !base64Left && existsSync(manifest);
  say(ok ? "PASS: the capture pipeline kept the screenshot" : "FAIL: see above");
  return ok ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exitCode = 1;
  },
);
