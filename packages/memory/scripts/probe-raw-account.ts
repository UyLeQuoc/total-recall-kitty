import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { fromBase64, fromHex, toHex } from "@mysten/sui/utils";
import { readOperatorEnv } from "../src/index.ts";

const env = readOperatorEnv();
const client = new SuiGrpcClient({
  network: "mainnet",
  baseUrl: "https://fullnode.mainnet.sui.io:443",
});
const res = await client.core.getObject({
  objectId: env.MEMWAL_ACCOUNT_ID,
  include: { json: true },
});
const obj = res.object as { type?: string; version?: string; json?: Record<string, unknown> };
console.log("type   :", obj.type);
console.log("version:", obj.version);
console.log("\nraw json keys:", Object.keys(obj.json ?? {}));
console.log(JSON.stringify(obj.json, null, 1).slice(0, 2600));

const mine = Ed25519Keypair.fromSecretKey(fromHex(env.MEMWAL_PRIVATE_KEY));
const minePub = toHex(mine.getPublicKey().toRawBytes());
console.log("\nour delegate public key:", minePub);
console.log("our delegate address   :", mine.getPublicKey().toSuiAddress());

const list = (obj.json?.delegate_keys ?? []) as unknown[];
console.log(`\ndelegate_keys entries: ${list.length}`);
for (const d of list) {
  const f = (d as { fields?: Record<string, unknown> }).fields ?? (d as Record<string, unknown>);
  const pk = f.public_key;
  const hex =
    typeof pk === "string"
      ? /^[0-9a-f]{64}$/i.test(pk)
        ? pk
        : toHex(fromBase64(pk))
      : Array.isArray(pk)
        ? toHex(Uint8Array.from(pk as number[]))
        : "?";
  console.log(
    `  ${f.label}  pub=${hex}  addr=${f.sui_address}  ${hex.toLowerCase() === minePub.toLowerCase() ? "<-- OURS" : ""}`,
  );
}
