// Entry point: the Figma guard as a Claude Code PreToolUse hook.
//   node guard-hook.js --config <figma-guard.json> [--log <file.jsonl>]
// Without a readable config every Figma call is blocked. Exit 0 allows, exit 2 blocks.
import { parseArgs } from "node:util";
import { runPreToolUseHook } from "../hooks/run.js";
import { evaluateFigmaToolCall } from "./guard.js";
import { readFigmaGuardConfig } from "./guard-settings.js";

const WATCHDOG_MS = 10_000;

function fail(message: string): never {
  process.stderr.write(`Blocked by Figma guard: ${message}\n`);
  process.exit(2);
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { config: { type: "string" }, log: { type: "string" } },
    strict: true,
    allowPositionals: false,
  });
  if (!values.config) fail("no --config given.");
  let config: ReturnType<typeof readFigmaGuardConfig>;
  try {
    config = readFigmaGuardConfig(values.config);
  } catch (err) {
    fail(`the guard is misconfigured (${(err as Error).message}).`);
  }
  return runPreToolUseHook(
    (call) =>
      evaluateFigmaToolCall(call, config.policy, {
        serverName: config.serverName,
        ...(config.allowedTools ? { allowedTools: config.allowedTools } : {}),
      }),
    { stdin: process.stdin, stderr: process.stderr },
    { guard: "figma", ...(values.log ? { logFile: values.log } : {}) },
  );
}

setTimeout(() => fail("the guard timed out."), WATCHDOG_MS).unref();
main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => fail(`the guard failed: ${(err as Error).message}`),
);
