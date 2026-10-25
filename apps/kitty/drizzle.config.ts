import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../.env"), quiet: true });

// Kitty keeps its own Postgres schema (ADR-0060), so pushing never touches Remora's tables.
export default defineConfig({
  schema: ["./src/db/schema.ts"],
  schemaFilter: ["kitty"],
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://kitty:kitty@localhost:5436/kitty",
  },
});
