/**
 * Default orchestrator port (the spec §4 diagram). Not 4318: that is the OpenTelemetry
 * OTLP/HTTP port, which a local collector may already hold (PM phase 1, S12).
 */
export const DEFAULT_PORT = 4100;
export const DEFAULT_HOST = "127.0.0.1";

/** Port from `ORCH_PORT`, defaulting to 4100. */
export function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ORCH_PORT;
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ORCH_PORT: ${raw}`);
  }
  return port;
}
