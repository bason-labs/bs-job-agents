import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  // First hits compile routes in `next dev`; give them room.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm exec next dev --port ${PORT}`,
    url: baseURL,
    // e2e always runs on the mock backend (lib/api/mock), never on an orchestrator that happens to
    // be running; its simulated bots run 3× faster.
    env: { BSJA_API_MODE: "mock", BSJA_MOCK_SPEED: process.env.BSJA_MOCK_SPEED ?? "3" },
    // Opt-in only (E2E_REUSE=1): agents run e2e from parallel worktrees, and silently
    // reusing a server already on the port would test another worktree's code. Use
    // E2E_PORT to run several suites side by side.
    reuseExistingServer: process.env.E2E_REUSE === "1",
    timeout: 120_000,
  },
});
