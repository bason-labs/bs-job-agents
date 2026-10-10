import { DEFAULT_HOST, resolvePort } from "./config.js";
import { buildServer } from "./server.js";

const app = buildServer({ logger: true });
const port = resolvePort();

// Local only: the orchestrator serves the web UI on the same machine.
app.listen({ port, host: DEFAULT_HOST }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
