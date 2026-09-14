/**
 * Vitest config for the React console (ui/).
 *
 * Deliberately separate from vite.config.ts: that one sets `root: ui` to lay
 * out the production bundle, whereas these tests want the repo root as the
 * project root. The core suite in test/ keeps running under node's own test
 * runner via `npm run test:core`.
 */
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["ui/src/**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"],
    restoreMocks: true,
  },
});
