import { createClient, limiterFor, readOperatorEnv, runLimited } from "../src/index.ts";

const env = readOperatorEnv();
const base = {
  key: env.MEMWAL_PRIVATE_KEY,
  accountId: env.MEMWAL_ACCOUNT_ID,
  serverUrl: env.MEMWAL_SERVER_URL,
};
const lim = limiterFor(env.MEMWAL_PRIVATE_KEY);

const tagged = createClient({ mode: "guest", ...base, namespace: "spike-recall-tagged:s3" });
const bare = createClient({ mode: "guest", ...base, namespace: "spike-recall-bare:s3" });
const q = "which package manager should I use?";

console.log("A. client default namespace = bare, no namespace arg:");
console.log(
  JSON.stringify(await runLimited(lim, () => bare.recall({ query: q, limit: 3 })), null, 1).slice(
    0,
    600,
  ),
);

console.log("\nB. client default = tagged, namespace arg = bare:");
console.log(
  JSON.stringify(
    await runLimited(lim, () =>
      tagged.recall({ query: q, limit: 3, namespace: "spike-recall-bare:s3" }),
    ),
    null,
    1,
  ).slice(0, 600),
);

console.log("\nC. positional form recall(query, limit, namespace):");
console.log(
  JSON.stringify(
    await runLimited(lim, () => tagged.recall(q, 3, "spike-recall-bare:s3")),
    null,
    1,
  ).slice(0, 600),
);
