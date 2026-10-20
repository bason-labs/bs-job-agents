// Entry point: the site guard as a Claude Code PreToolUse hook.
//   node hook.js --allow topcv.vn --allow itviec.com [--log <file.jsonl>] [--tool-prefix <p>] [--browser <deviceId>]
// The allowlist may also come from BS_SITE_GUARD_ALLOW (comma-separated). Exit 0 allows the
// tool call; exit 2 blocks it and the message on stderr goes back to the model.
import { parseArgs } from "node:util";
import { runPreToolUseHook } from "../../hooks/run.js";
import { evaluateChromeToolCall } from "./guard.js";

const WATCHDOG_MS = 10_000;

function fail(message: string): never {
  process.stderr.write(`Blocked by site guard: ${message}\n`);
  process.exit(2);
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      allow: { type: "string", multiple: true },
      log: { type: "string" },
      "tool-prefix": { type: "string" },
      browser: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const fromArgs = (values.allow ?? []).flatMap((v) => v.split(","));
  const fromEnv = (process.env.BS_SITE_GUARD_ALLOW ?? "").split(",");
  const allowedSites = (fromArgs.length > 0 ? fromArgs : fromEnv).map((s) => s.trim()).filter((s) => s !== "");
  const toolPrefix = values["tool-prefix"];
  const browserId = values.browser?.trim();

  return runPreToolUseHook(
    (call) => evaluateChromeToolCall(call, { allowedSites, ...(toolPrefix ? { toolPrefix } : {}), ...(browserId ? { browserId } : {}) }),
    { stdin: process.stdin, stderr: process.stderr },
    { guard: "site", ...(values.log ? { logFile: values.log } : {}) },
  );
}

setTimeout(() => fail("the guard timed out."), WATCHDOG_MS).unref();
main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => fail(`the guard failed: ${(err as Error).message}`),
);
