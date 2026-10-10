import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    globals: false,
    css: false,
    include: ["{app,components,features,lib,hooks,tests}/**/*.{test,spec}.{ts,tsx}"],
    // Playwright specs live in e2e/ and run only via `pnpm e2e`.
    exclude: ["node_modules/**", ".next/**", "e2e/**"],
  },
});
