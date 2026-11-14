import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// VITE_BASE lets the same build live under a sub-path, e.g. "/tenured/"
// on GitHub Pages.
const base = process.env.VITE_BASE ?? "/";

export default defineConfig({
  base: base.endsWith("/") ? base : `${base}/`,
  plugins: [react()],
  build: { target: "es2022", sourcemap: true },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
