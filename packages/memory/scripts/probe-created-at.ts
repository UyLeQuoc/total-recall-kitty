/**
 * Does the deployed mainnet relayer return `created_at` on recall results?
 *
 * The SDK types document it as optional, "because relayers older than this
 * field omit it", and newest-wins ordering (`orderNewestFirst`) prefers it over
 * the day parsed out of our own text. This reads a namespace that already holds
 * memories and prints exactly which fields came back, rather than assuming.
 */
import { createClient, limiterFor, readOperatorEnv, runLimited } from "../src/index.ts";

const env = readOperatorEnv();
const namespace = process.argv[2] ?? "spike-recall-bare:s3";
const client = createClient({
  mode: "guest",
  key: env.MEMWAL_PRIVATE_KEY,
  accountId: env.MEMWAL_ACCOUNT_ID,
  serverUrl: env.MEMWAL_SERVER_URL,
  namespace,
});
const lim = limiterFor(env.MEMWAL_PRIVATE_KEY);

const res = await runLimited(lim, () =>
  client.recall({ query: "which package manager should I use?", namespace, limit: 3 }),
);
console.log(`namespace ${namespace}: ${res.results.length} results`);
for (const r of res.results) {
  const fields = Object.keys(r).join(", ");
  console.log(`  fields: ${fields}`);
  console.log(`  created_at: ${(r as { created_at?: string }).created_at ?? "(absent)"}`);
  console.log(`  text: ${r.text.slice(0, 70)}`);
}
