// Kitty's web (ADR-0064): dev on 5182, `/api` proxied to Kitty's server; built into web/dist, which the
// server then serves itself.
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  // `@/` like Remora's web, so the kit copied from it (ADR-0066) keeps its imports.
  resolve: { alias: { "@": resolve(import.meta.dirname, "src") } },
  // One chunk: React, dapp-kit and the Sui SDK are most of it, and the app is three pages.
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1200 },
  server: {
    port: Number(process.env.KITTY_WEB_PORT ?? 5182),
    strictPort: true,
    proxy: { "/api": `http://localhost:${process.env.KITTY_PORT ?? 8821}` },
  },
});
