// Where the orchestrator is and which backend the UI uses. Read on the server at request time
// (the (shell) layout is dynamic), so nothing is frozen into the build:
//   ORCH_URL          full orchestrator URL (server side); else
//   ORCH_PORT         port on 127.0.0.1 (the orchestrator's own override); default 4100
//   BSJA_API_MODE     live | mock | auto (default). auto = live in production; in development,
//                     live when the orchestrator answers, else the mock backend (labelled in the UI)
//   BSJA_MOCK_SPEED   speed factor for the mock's simulated bots (e2e uses a faster one)
// Browser requests never go to the orchestrator directly: it sends no CORS headers (PM S18),
// so they go through the same-origin proxy at /api/orch (lib/api/proxy.ts).
import type { ApiMode } from "./contract";

export const DEFAULT_ORCH_URL = "http://127.0.0.1:4100";
export const BROWSER_API_BASE = "/api/orch";

type Env = Record<string, string | undefined>;
const processEnv = (): Env => (typeof process === "undefined" ? {} : process.env);

export function orchestratorUrl(env: Env = processEnv()): string {
  if (env.ORCH_URL) return env.ORCH_URL.replace(/\/+$/, "");
  const port = Number(env.ORCH_PORT);
  if (env.ORCH_PORT && Number.isInteger(port) && port > 0 && port < 65536) return `http://127.0.0.1:${port}`;
  return DEFAULT_ORCH_URL;
}

export type ApiModeSetting = ApiMode | "auto";

export function apiModeSetting(env: Env = processEnv()): ApiModeSetting {
  const v = env.BSJA_API_MODE?.trim().toLowerCase();
  return v === "live" || v === "mock" ? v : "auto";
}

export function mockSpeed(env: Env = processEnv()): number {
  const n = Number(env.BSJA_MOCK_SPEED);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** True when anything answers on the orchestrator's /health (even a degraded start, PM S19). */
export async function probeOrchestrator(baseUrl: string, fetchImpl: typeof fetch = fetch, timeoutMs = 600): Promise<boolean> {
  try {
    await fetchImpl(`${baseUrl}/health`, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

export async function resolveApiMode(
  env: Env = processEnv(),
  probe: () => Promise<boolean> = () => probeOrchestrator(orchestratorUrl(env)),
): Promise<ApiMode> {
  const setting = apiModeSetting(env);
  if (setting !== "auto") return setting;
  if (env.NODE_ENV === "production") return "live";
  return (await probe()) ? "live" : "mock";
}
