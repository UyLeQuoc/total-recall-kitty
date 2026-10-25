import { createClient, limiterFor, readOperatorEnv, runLimited } from "../src/index.ts";

const env = readOperatorEnv();
const ns = process.argv[2];
if (!ns) throw new Error("usage: tsx scripts/probe-restore.ts <namespace>");
const client = createClient({
  mode: "guest",
  key: env.MEMWAL_PRIVATE_KEY,
  accountId: env.MEMWAL_ACCOUNT_ID,
  serverUrl: env.MEMWAL_SERVER_URL,
  namespace: ns,
});
const lim = limiterFor(env.MEMWAL_PRIVATE_KEY);
console.log("namespace:", ns);
console.log(
  "recall   :",
  (await runLimited(lim, () => client.recall({ query: "dog editor", namespace: ns, limit: 5 })))
    .results.length,
  "results",
);
for (const limit of [10, 50, 100]) {
  const r = await runLimited(lim, () => client.restore(ns, limit));
  console.log(`restore(limit=${limit}):`, JSON.stringify(r));
}
