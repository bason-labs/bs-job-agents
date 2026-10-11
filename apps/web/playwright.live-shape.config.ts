import { defineConfig, devices } from "@playwright/test";

// Live-shape lane (PM3 S9, spec §12 "Playwright + FakeRunner"): the web app in LIVE mode against
// the REAL orchestrator (built dist/: real API, SSE, Lead MCP server, engine and scan checker) on a
// throwaway data folder, with FakeRunner standing in for the claude/codex CLIs and fake Chrome and
// Figma bridges (apps/orchestrator/e2e/live-shape-launcher.ts, test only). No CLI, Chrome or Figma
// is ever called. Run `pnpm e2e:live-shape` from the repo root (it builds the orchestrator first).
// The mock lane (playwright.config.ts) is unchanged.

const WEB_PORT = Number(process.env.E2E_LIVE_PORT ?? 3399);
const ORCH_PORT = Number(process.env.E2E_ORCH_PORT ?? 4199);
const CONTROL_PORT = Number(process.env.E2E_CONTROL_PORT ?? 4198);
const baseURL = `http://localhost:${WEB_PORT}`;

export default defineConfig({
  testDir: "./e2e/live-shape",
  // One orchestrator for the lane: each test resets it to a fresh data folder, one at a time.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: { baseURL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: [
    {
      command: "pnpm --filter @bs-job-agents/orchestrator e2e:launcher",
      url: `http://127.0.0.1:${CONTROL_PORT}/ready`,
      env: {
        E2E_ORCH_PORT: String(ORCH_PORT),
        E2E_CONTROL_PORT: String(CONTROL_PORT),
        ORCH_WEB_ORIGINS: `http://localhost:${WEB_PORT},http://127.0.0.1:${WEB_PORT}`,
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `pnpm exec next dev --port ${WEB_PORT}`,
      url: baseURL,
      env: { BSJA_API_MODE: "live", ORCH_PORT: String(ORCH_PORT) },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
