// The offline HTML report (SPEC §10.3): one self-contained file — JS, CSS and fonts inlined —
// written to src-tauri/resources/report.html, which the app fills with data on export.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname, "report"),
  plugins: [react(), viteSingleFile()],
  define: {
    __INCASK_MOCK__: "false",
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? "0.1.0"),
  },
  build: {
    outDir: resolve(__dirname, "src-tauri/resources"),
    emptyOutDir: false,
    target: "es2021",
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    rollupOptions: { input: resolve(__dirname, "report/report.html") },
  },
});
