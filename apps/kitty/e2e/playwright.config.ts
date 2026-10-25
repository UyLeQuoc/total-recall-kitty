/**
 * Kitty's web on testnet (ADR-0064): the API on 8821 (no keeper stream, no bot) and the web on 5182,
 * never 8787/5173. Members sign with an injected test wallet (`test-wallet.ts`). Not part of
 * `bun run test`: it spends testnet gas (the sponsor's) and writes mainnet memories.
 *   bun run e2e
 */
import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { loadEnv } from "@total-recall/memory";

loadEnv();

const app = resolve(import.meta.dirname, "..");

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.e2e\.ts$/,
  outputDir: "../test-results/e2e",
  timeout: 15 * 60_000,
  expect: { timeout: 90_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://localhost:5182",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "bun --env-file=../../.env src/main.ts",
      cwd: app,
      url: "http://localhost:8821/health",
      reuseExistingServer: false,
      timeout: 60_000,
      env: { KITTY_PORT: "8821", KITTY_WORKER: "off", KITTY_BOT: "off" },
    },
    {
      command: "bunx vite --config web/vite.config.ts",
      cwd: app,
      url: "http://localhost:5182",
      reuseExistingServer: false,
      timeout: 60_000,
      env: { KITTY_PORT: "8821", KITTY_WEB_PORT: "5182" },
    },
  ],
});
