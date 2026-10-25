import { EncryptedObject } from "@mysten/seal";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { fromHex } from "@mysten/sui/utils";
import { createSuiClient, readAccount, readOperatorEnv } from "../src/index.ts";

const env = readOperatorEnv();
const client = createSuiClient(env.SUI_NETWORK);
const account = await readAccount(client, env.MEMWAL_ACCOUNT_ID);
const mine = Ed25519Keypair.fromSecretKey(fromHex(env.MEMWAL_PRIVATE_KEY))
  .getPublicKey()
  .toSuiAddress();

console.log("account active:", account?.active, "owner:", account?.owner);
console.log("on-chain delegates:");
for (const d of account?.delegates ?? []) {
  console.log(
    `  ${d.suiAddress || "?"}  ${d.label}  ${d.publicKeyHex.slice(0, 16)}…  ${d.suiAddress === mine ? "  <-- OURS" : ""}`,
  );
}
console.log("our delegate address:", mine);
console.log(
  "registered on chain:",
  (account?.delegates ?? []).some((d) => d.suiAddress === mine),
);

const blobId = process.argv[2];
if (blobId) {
  const res = await fetch(`https://aggregator.walrus-mainnet.walrus.space/v1/blobs/${blobId}`);
  const parsed = EncryptedObject.parse(new Uint8Array(await res.arrayBuffer()));
  const id = parsed.id;
  console.log(`\nseal identity (${id.length / 2} bytes): ${id}`);
  console.log(`  owner hex : ${(account?.owner ?? "").replace(/^0x/, "")}`);
  console.log(
    `  starts with owner: ${id.toLowerCase().startsWith((account?.owner ?? "").replace(/^0x/, "").toLowerCase())}`,
  );
  console.log(`  tail after owner : ${id.slice(64)}`);
  console.log(`  parsed.packageId : ${parsed.packageId}`);
  console.log(`  threshold        : ${parsed.threshold}`);
  console.log(`  services         : ${parsed.services?.length ?? "?"}`);
}
