// Orchestrator entry: `pnpm dev:orchestrator` (tsx watch) or `node dist/index.js`. Serves the API on
// 127.0.0.1:4100 (ORCH_PORT) against the repo's data/ (ORCH_DATA_DIR). Nothing runs a bot until Ba
// starts work or a schedule he created fires; start-up only continues runs a restart interrupted.
import { startOrchestrator } from "./api/boot/start.js";
import { resolveConfig } from "./config.js";

async function main(): Promise<void> {
  const config = resolveConfig();
  const orch = await startOrchestrator({ config, logger: { level: process.env.ORCH_LOG_LEVEL ?? "info" } });
  const address = await orch.listen();
  const s = orch.ctx.state;
  orch.app.log.info(
    s.state === "running"
      ? `orchestrator listening on ${address}, data in ${config.dataDir}`
      : `orchestrator listening on ${address} in DEGRADED mode (${s.reason}): ${s.detail}`,
  );
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      orch.app.log.info(`${signal}: shutting down`);
      void orch.close().finally(() => process.exit(0));
    });
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
