import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(__dirname, "ui"),
  plugins: [react()],
  // Absolute base, not "./": every console page now has its own path
  // (/console/sessions, /console/tools, ...), and a relative base resolves the
  // bundle against the page path — at /console/sessions/ that produced
  // /console/sessions/assets/... and a blank page.
  base: "/console/",
  build: {
    outDir: resolve(__dirname, "dist/ui"),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, "ui/console.html"),
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
