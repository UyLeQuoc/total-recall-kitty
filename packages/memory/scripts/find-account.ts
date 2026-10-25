/**
 * Resolve the MemWalAccount object ID (what MEMWAL_ACCOUNT_ID must hold).
 *   tsx scripts/find-account.ts                 → uses the owner the relayer resolves for the delegate key
 *   tsx scripts/find-account.ts <owner-address> → looks up that owner
 */
import {
  createSuiClient,
  findAccountIdForOwner,
  RelayerExtras,
  readOperatorEnv,
} from "../src/index.ts";

const env = readOperatorEnv();
let owner = process.argv[2];

if (!owner) {
  const extras = new RelayerExtras({
    key: env.MEMWAL_PRIVATE_KEY,
    accountId: env.MEMWAL_ACCOUNT_ID,
    serverUrl: env.MEMWAL_SERVER_URL,
  });
  owner = (await extras.stats("default")).owner;
  console.log("owner resolved from the delegate key:", owner);
}

const client = createSuiClient(env.SUI_NETWORK);
const accountId = await findAccountIdForOwner(client, env.MEMWAL_REGISTRY_ID, owner);
if (!accountId) {
  console.log(`no MemWalAccount found for ${owner}`);
  process.exit(1);
}
console.log("");
console.log("MEMWAL_ACCOUNT_ID =", accountId);
console.log("owner (SUI address) =", owner);
console.log("explorer:", `https://suiscan.xyz/mainnet/object/${accountId}`);
