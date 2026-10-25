/**
 * Where exactly does /sponsor fail?
 *
 * Three probes, none of which change anything on chain: the relayer either
 * rejects a request itself, or forwards it upstream and reports what came back.
 * Telling those apart decides whether a 502 on the onboarding flow is our
 * transaction or their sponsor service.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, toBase64 } from "@mysten/sui/utils";
import { createSponsorAuthorization } from "@mysten-incubation/memwal";
import { createSuiClient, fetchRelayerConfig, readOperatorEnv } from "../src/index.ts";

const SUI_CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006";
const arg = process.argv[2];
if (!arg) throw new Error("usage: tsx scripts/probe-sponsor.ts <address>");
const address: string = arg;

function keypairFor(addr: string): Ed25519Keypair {
  const path = join(homedir(), ".sui", "sui_config", "sui.keystore");
  for (const entry of JSON.parse(readFileSync(path, "utf8")) as string[]) {
    const bytes = fromBase64(entry);
    if (bytes[0] !== 0) continue;
    const kp = Ed25519Keypair.fromSecretKey(bytes.slice(1));
    if (kp.getPublicKey().toSuiAddress() === addr) return kp;
  }
  throw new Error("key not found");
}

const env = readOperatorEnv();
const cfg = await fetchRelayerConfig(env.MEMWAL_SERVER_URL);
const sui = createSuiClient(env.SUI_NETWORK);
const keypair = keypairFor(address);

async function probe(label: string, tx: Transaction, withAuth = true) {
  // biome-ignore lint/suspicious/noExplicitAny: client type varies by transport
  const kindBytes = await tx.build({ client: sui as any, onlyTransactionKind: true });
  const auth = withAuth
    ? await createSponsorAuthorization(address, kindBytes, async (message) => {
        const { signature } = await keypair.signPersonalMessage(message);
        return { signature };
      })
    : {
        authNonce: crypto.randomUUID(),
        authSignature: "bogus",
        authTimestamp: Math.floor(Date.now() / 1000),
      };

  const res = await fetch(`${env.MEMWAL_SERVER_URL}/sponsor`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      transactionBlockKindBytes: toBase64(kindBytes),
      sender: address,
      ...auth,
    }),
  });
  console.log(`  ${label}\n    ${res.status}  ${(await res.text()).slice(0, 150)}`);
}

console.log(`sender ${address}`);
console.log(`package from /config: ${cfg.packageId}\n`);

const allowed = new Transaction();
allowed.moveCall({
  target: `${cfg.packageId}::account::create_account`,
  arguments: [allowed.object(env.MEMWAL_REGISTRY_ID), allowed.object(SUI_CLOCK)],
});
await probe("1. create_account, on the allowlist, valid auth", allowed);

const staleRegistry = new Transaction();
staleRegistry.moveCall({
  target: `${cfg.packageId}::account::create_account`,
  arguments: [
    // The registry the published docs still name, from the superseded deployment.
    staleRegistry.object("0x0da982cefa26864ae834a8a0504b904233d49e20fcc17c373c8bed99c75a7edd"),
    staleRegistry.object(SUI_CLOCK),
  ],
});
await probe("1b. create_account, current package, the documented registry", staleRegistry);

const notAllowed = new Transaction();
notAllowed.moveCall({
  target: "0x2::clock::timestamp_ms",
  arguments: [notAllowed.object(SUI_CLOCK)],
});
await probe("2. a call that is NOT on the allowlist", notAllowed);

const wrongPackage = new Transaction();
wrongPackage.moveCall({
  // The package the published docs still name, superseded by the upgrade.
  target:
    "0xcee7a6fd8de52ce645c38332bde23d4a30fd9426bc4681409733dd50958a24c6::account::create_account",
  arguments: [wrongPackage.object(env.MEMWAL_REGISTRY_ID), wrongPackage.object(SUI_CLOCK)],
});
await probe("3. create_account on the stale documented package", wrongPackage);

await probe("4. allowlisted call, deliberately bad auth", allowed, false);
