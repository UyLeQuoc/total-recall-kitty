import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config, parse } from "dotenv";
import { z } from "zod";

/** Walk up from cwd until a `.env` is found (repo root), then load it. Idempotent. */
export function loadEnv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, ".env");
    if (existsSync(candidate)) {
      config({ path: candidate, quiet: true });
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

/**
 * `SURVEY_URL=` in an env file sets the variable to "", which is not the same
 * as leaving it out: an optional URL field rejects "" as an invalid URL, and
 * the server refused to start from a freshly copied `.env.example`. Every
 * schema reads through this, so a blank value means "not set".
 */
export function withoutBlanks(source: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter(
      (e): e is [string, string] => e[1] !== undefined && e[1].trim() !== "",
    ),
  );
}

/** An env file's text as the process would see it, for testing `.env.example`. */
export function parseEnvText(text: string): Record<string, string> {
  return parse(text);
}

const hex64 = z.string().regex(/^[0-9a-fA-F]{64}$/, "expected 64 hex chars");
const suiId = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected 0x + 64 hex chars");

export const operatorEnvSchema = z.object({
  MEMWAL_ACCOUNT_ID: suiId,
  MEMWAL_PRIVATE_KEY: hex64,
  MEMWAL_SERVER_URL: z.string().url().default("https://relayer.memory.walrus.xyz"),
  /** Fallback only. Prefer fetchRelayerConfig(); the package is upgradeable. */
  MEMWAL_PACKAGE_ID: suiId,
  MEMWAL_REGISTRY_ID: suiId,
  SUI_NETWORK: z.enum(["mainnet", "testnet"]).default("mainnet"),
});
export type OperatorEnv = z.infer<typeof operatorEnvSchema>;

export function readOperatorEnv(): OperatorEnv {
  loadEnv();
  const parsed = operatorEnvSchema.safeParse(withoutBlanks(process.env));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Walrus Memory operator env is incomplete: ${issues}`);
  }
  return parsed.data;
}
