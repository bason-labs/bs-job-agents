import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // The floating dev badge overlaps the sidebar usage card (and e2e screenshots).
  devIndicators: false,
  transpilePackages: ["@bs-job-agents/shared"],
  // Monorepo root, so Turbopack and file tracing see packages/shared.
  turbopack: { root: path.join(__dirname, "../../") },
  outputFileTracingRoot: path.join(__dirname, "../../"),
  // Lead's chat is the main chat (/chat); its "direct chat" URL just goes there.
  // A config redirect answers before rendering, so the shell never flashes.
  async redirects() {
    return [{ source: "/chat/lead", destination: "/chat", permanent: false }];
  },
  // The orchestrator sends no CORS headers (PM S18): the browser reaches it as /api/* on this
  // origin (REST, files, SSE). proxy.ts forwards it to 127.0.0.1:4100 (ORCH_URL / ORCH_PORT, read
  // per request, so `next start` honours them at run time; a config rewrite froze them at build).
};

export default nextConfig;
