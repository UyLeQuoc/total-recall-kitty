/**
 * Spikes 3 and 4 — the owned-mode flow, and the question the whole submission
 * rests on: when a delegate key is removed on chain, does the relayer stop
 * honouring it?
 *
 * Answered 2026-09-22: yes, after about 32 seconds. The key still authenticated
 * 15 seconds after leaving the chain and was refused by 32. Full log in
 * docs/evidence/revocation-2026-09-22.md. Re-run it whenever the relayer
 * version changes; the number is a measurement, not a guarantee.
 *
 * Uses a throwaway MemWalAccount created for a wallet that has none, so nothing
 * of value is revoked. Transactions are sponsored when the relayer will sponsor
 * them and paid by this wallet when it will not, which since 2026-09-22 is
 * always (docs/issues/11-sponsor-upstream-502.md). Each one costs a fraction of
 * a cent in gas, and the script prints who paid.
 *
 *   tsx scripts/spike-revoke.ts <keystore-address>
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { fromBase64 } from "@mysten/sui/utils";
import {
  addDelegateKeyTx,
  createAccountTx,
  createClient,
  createSuiClient,
  executeAccountTx,
  fetchRelayerConfig,
  findAccountIdForOwner,
  generateDelegate,
  readAccount,
  readOperatorEnv,
  removeDelegateKeyTx,
  type SponsorContext,
} from "../src/index.ts";

const wanted = process.argv[2];
if (!wanted) throw new Error("usage: tsx scripts/spike-revoke.ts <address from the sui keystore>");

function keypairFor(address: string): Ed25519Keypair {
  const path = join(homedir(), ".sui", "sui_config", "sui.keystore");
  for (const entry of JSON.parse(readFileSync(path, "utf8")) as string[]) {
    const bytes = fromBase64(entry);
    if (bytes[0] !== 0) continue;
    const kp = Ed25519Keypair.fromSecretKey(bytes.slice(1));
    if (kp.getPublicKey().toSuiAddress() === address) return kp;
  }
  throw new Error(`no Ed25519 key for ${address} in the keystore`);
}

const env = readOperatorEnv();
const cfg = await fetchRelayerConfig(env.MEMWAL_SERVER_URL);
const sui = createSuiClient(env.SUI_NETWORK);
const keypair = keypairFor(wanted);
const owner = keypair.getPublicKey().toSuiAddress();

const ctx: SponsorContext = {
  relayerUrl: env.MEMWAL_SERVER_URL,
  packageId: cfg.packageId,
  registryId: env.MEMWAL_REGISTRY_ID,
  keypair,
  suiClient: sui,
};

console.log(`owner   ${owner}`);
console.log(`package ${cfg.packageId}  (from /config, not the docs)`);

// ── 1. an account, if this wallet has none ────────────────────────────────
let accountId = await findAccountIdForOwner(sui, env.MEMWAL_REGISTRY_ID, owner);
if (accountId) {
  console.log(`\n1. account already exists: ${accountId}`);
} else {
  console.log("\n1. creating a MemWalAccount");
  const created = await executeAccountTx(ctx, () => createAccountTx(ctx));
  console.log(`   tx ${created.digest}  (gas paid by ${created.paidBy})`);
  for (let i = 0; i < 15 && !accountId; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    accountId = await findAccountIdForOwner(sui, env.MEMWAL_REGISTRY_ID, owner);
  }
  if (!accountId) throw new Error("account created but never appeared in the registry");
  console.log(`   account ${accountId}`);
}

// ── 2. a delegate key, registered on chain ────────────────────────────────
const delegate = await generateDelegate();
console.log(`\n2. registering a delegate key: ${delegate.publicKeyHex.slice(0, 16)}…`);
const added = await executeAccountTx(ctx, () =>
  addDelegateKeyTx(ctx, accountId as string, delegate.publicKeyHex, "hippo revoke spike"),
);
console.log(`   tx ${added.digest}  (gas paid by ${added.paidBy})`);

const isOnChain = (a: Awaited<ReturnType<typeof readAccount>>) =>
  (a?.delegates ?? []).some((d) => d.publicKeyHex === delegate.publicKeyHex.toLowerCase());

/**
 * The sponsored execute returns before the node we read from has the new
 * version, so poll rather than reading once. Without this the spike measures
 * read lag and calls it revocation.
 */
async function waitForChain(want: boolean, label: string): Promise<number> {
  const started = Date.now();
  for (let i = 0; i < 40; i++) {
    const acct = await readAccount(sui, accountId as string);
    if (isOnChain(acct) === want) {
      const secs = Math.round((Date.now() - started) / 1000);
      console.log(`   ${label} after ${secs}s  (${acct?.delegates.length} delegate(s) total)`);
      return secs;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`chain never showed the key ${want ? "present" : "absent"}`);
}

await waitForChain(true, "on chain");

// ── 3. the key works ──────────────────────────────────────────────────────
const NS = "revoke-spike";
const client = createClient({
  mode: "owned",
  key: delegate.privateKeyHex,
  accountId,
  serverUrl: env.MEMWAL_SERVER_URL,
  namespace: NS,
});
console.log("\n3. using the key before revocation");
const stored = await client.rememberAndWait(
  "The revoke spike ran and this memory was written before revocation.",
  NS,
  { timeoutMs: 120_000 },
);
console.log(`   wrote blob ${stored.blob_id}`);
const before = await client.recall({
  query: "what did the revoke spike write?",
  namespace: NS,
  limit: 3,
});
console.log(`   recall returned ${before.results.length}`);

// ── 4. revoke, then measure ───────────────────────────────────────────────
console.log("\n4. removing the delegate key on chain");
const removed = await executeAccountTx(ctx, () =>
  removeDelegateKeyTx(ctx, accountId as string, delegate.publicKeyHex),
);
console.log(`   tx ${removed.digest}  (gas paid by ${removed.paidBy})`);
await waitForChain(false, "gone from chain");

console.log("\n5. does the relayer still honour the removed key?");
const started = Date.now();
let stillWorking = true;
for (let attempt = 1; attempt <= 20; attempt++) {
  const elapsed = Math.round((Date.now() - started) / 1000);
  try {
    const res = await client.recall({
      query: "what did the revoke spike write?",
      namespace: NS,
      limit: 3,
    });
    console.log(`   +${elapsed}s  ACCEPTED, ${res.results.length} result(s)`);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    console.log(
      `   +${elapsed}s  refused (${err.status ?? "?"}) ${String(err.message).slice(0, 70)}`,
    );
    stillWorking = false;
    break;
  }
  await new Promise((r) => setTimeout(r, 15_000));
}

console.log(
  stillWorking
    ? `\nVERDICT: the relayer still accepted the removed key for the whole ${Math.round((Date.now() - started) / 1000)}s window.`
    : `\nVERDICT: the relayer stopped accepting the key after about ${Math.round((Date.now() - started) / 1000)}s.`,
);
console.log(`account ${accountId}  namespace ${NS}`);
