/**
 * Phase 0 step 1 and 2. Read the operator account's SEAL counter, dry-run
 * `account::seal_approve` on a document-prefixed identity, then encrypt a
 * tiny payload to the mainnet committee key server and try to decrypt it.
 *
 * Prints statuses and ids. Does not print the delegate private key or the
 * plaintext.
 */
import { EncryptedObject, SealClient, SessionKey } from "@mysten/seal";
import { bcs } from "@mysten/sui/bcs";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { fromHex, normalizeSuiAddress, toHex } from "@mysten/sui/utils";
import { createSuiClient, fetchRelayerConfig, readOperatorEnv } from "../src/index.ts";

const COMMITTEE = "0x686098f1439237fff9f36b99c7329683c22979d2005c2465cb891acb012a7595";
const AGGREGATOR = "https://seal-aggregator-mainnet.mystenlabs.com";
const PREFIX = "hippo-doc";

function describe(err: unknown): string {
  if (!(err instanceof Error)) return "non-error";
  const requestId =
    "requestId" in err && typeof err.requestId === "string" ? ` requestId=${err.requestId}` : "";
  return `${err.name}: ${err.message}${requestId}`;
}

function u64LeHex(counter: bigint): string {
  return toHex(bcs.u64().serialize(counter).toBytes());
}

function documentId(ownerHex: string, counter: bigint): string {
  return `${toHex(new TextEncoder().encode(PREFIX))}${ownerHex}${u64LeHex(counter)}`;
}

const env = readOperatorEnv();
const relayer = await fetchRelayerConfig(env.MEMWAL_SERVER_URL);
const sui = createSuiClient("mainnet");
const keypair = Ed25519Keypair.fromSecretKey(fromHex(env.MEMWAL_PRIVATE_KEY));
const delegate = keypair.getPublicKey().toSuiAddress();

const loaded = await sui.core.getObject({
  objectId: env.MEMWAL_ACCOUNT_ID,
  include: { json: true },
});
const object = loaded.object as { type?: string; json?: Record<string, unknown> } | null;
const json = object?.json;
const owner = typeof json?.owner === "string" ? normalizeSuiAddress(json.owner) : "";
const rawCounter = json?.access_counter_version;
const counter =
  typeof rawCounter === "string" || typeof rawCounter === "number" ? BigInt(rawCounter) : null;

console.log(`package     ${relayer.packageId}`);
console.log(`account     ${env.MEMWAL_ACCOUNT_ID}`);
console.log(`object type ${object?.type ?? "missing"}`);
console.log(`owner       ${owner || "missing"}`);
console.log(`active      ${String(json?.active)}`);
console.log(`counter     ${counter === null ? "missing" : counter.toString()}`);
console.log(`delegate    ${delegate}`);

if (!owner || counter === null) throw new Error("account did not expose owner and counter");

const ownerHex = owner.slice(2);
const good = documentId(ownerHex, counter);
const bad = documentId("00".repeat(32), counter);
console.log(`good id     ${good.slice(0, 24)}…${good.slice(-20)} (${good.length / 2} bytes)`);

async function approve(label: string, id: string, sender: string): Promise<void> {
  const tx = new Transaction();
  tx.setSender(sender);
  tx.moveCall({
    target: `${relayer.packageId}::account::seal_approve`,
    arguments: [
      tx.pure.vector("u8", Array.from(fromHex(id))),
      tx.object(env.MEMWAL_REGISTRY_ID),
      tx.object(env.MEMWAL_ACCOUNT_ID),
    ],
  });
  try {
    const simulated = await sui.core.simulateTransaction({ transaction: tx });
    const { status } = simulated.Transaction ?? simulated.FailedTransaction;
    console.log(`simulate ${label} ${JSON.stringify(status)}`);
  } catch (err) {
    console.log(`simulate ${label} FAILED ${describe(err)}`);
  }
}

await approve("prefixed-delegate", good, delegate);
await approve("wrong-owner-suffix", bad, delegate);
await approve(
  "prefixed-stranger",
  good,
  "0x0000000000000000000000000000000000000000000000000000000000000001",
);

const sealApiKey = process.env.SEAL_API_KEY ?? "";
const probe = await fetch(`${AGGREGATOR}/v1/service`, {
  headers: sealApiKey ? { "X-API-Key": sealApiKey } : {},
});
const probeBody = (await probe.text()).slice(0, 180);
console.log(`aggregator  ${probe.status} ${probeBody}`);

const seal = new SealClient({
  suiClient: sui,
  serverConfigs: [
    {
      objectId: COMMITTEE,
      weight: 1,
      aggregatorUrl: AGGREGATOR,
      ...(sealApiKey ? { apiKeyName: "X-API-Key", apiKey: sealApiKey } : {}),
    },
  ],
  verifyKeyServers: true,
});

let ciphertext: Uint8Array | null = null;
try {
  const encrypted = await seal.encrypt({
    threshold: 1,
    packageId: normalizeSuiAddress(relayer.packageId),
    id: good,
    data: new TextEncoder().encode("hippo-file-spike"),
  });
  ciphertext = encrypted.encryptedObject;
  const parsed = EncryptedObject.parse(ciphertext);
  console.log(`encrypt     ok ${ciphertext.length} bytes`);
  console.log(`sealed pkg  ${parsed.packageId}`);
  console.log(`threshold   ${parsed.threshold}`);
  console.log(
    `services    ${parsed.services.map(([id, weight]) => `${id} w${weight}`).join(", ")}`,
  );
} catch (err) {
  console.log(`encrypt     FAILED ${describe(err)}`);
}

if (ciphertext) {
  const parsed = EncryptedObject.parse(ciphertext);
  try {
    const sessionKey = await SessionKey.create({
      address: delegate,
      packageId: normalizeSuiAddress(parsed.packageId),
      ttlMin: 5,
      signer: keypair,
      suiClient: sui,
    });
    const tx = new Transaction();
    tx.setSender(delegate);
    tx.moveCall({
      target: `${relayer.packageId}::account::seal_approve`,
      arguments: [
        tx.pure.vector("u8", Array.from(fromHex(parsed.id))),
        tx.object(env.MEMWAL_REGISTRY_ID),
        tx.object(env.MEMWAL_ACCOUNT_ID),
      ],
    });
    const txBytes = await tx.build({ client: sui, onlyTransactionKind: true });
    await seal.fetchKeys({
      ids: [parsed.id],
      txBytes,
      sessionKey,
      threshold: parsed.threshold,
    });
    const plain = await seal.decrypt({ data: ciphertext, sessionKey, txBytes });
    const matches = new TextDecoder().decode(plain) === "hippo-file-spike";
    console.log(`decrypt     ${matches ? "roundtrip ok" : "roundtrip mismatch"}`);
  } catch (err) {
    console.log(`decrypt     FAILED ${describe(err)}`);
  }
}
