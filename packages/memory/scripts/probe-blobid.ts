/**
 * Prints one blob id this account owns, for scripts/spike-decrypt.ts.
 *
 * The read API is the only place that enumerates blobs; our own index holds
 * ids too, but taking one from the relayer proves the blob is really there.
 */
import { RelayerExtras, readOperatorEnv } from "../src/index.ts";

const env = readOperatorEnv();
const extras = new RelayerExtras({
  key: env.MEMWAL_PRIVATE_KEY,
  accountId: env.MEMWAL_ACCOUNT_ID,
  serverUrl: env.MEMWAL_SERVER_URL,
});
const all = await extras.allMemories();
console.log(all.length ? all[all.length - 1]?.blob_id : "none");
process.exit(0);
