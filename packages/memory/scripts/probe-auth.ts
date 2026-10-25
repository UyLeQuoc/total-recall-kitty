/**
 * Does the relayer accept a delegate key that was never registered on chain?
 *
 * Non-destructive: a freshly generated keypair is used for read-only calls
 * against our own account. Run as part of the session's bug bounty.
 */
import { MemWal } from "@mysten-incubation/memwal";
import { generateDelegate, readOperatorEnv } from "../src/index.ts";

const env = readOperatorEnv();
const fresh = await generateDelegate();
console.log("fresh keypair, never registered anywhere");
console.log("  public key:", fresh.publicKeyHex);
console.log("  address   :", fresh.suiAddress);

const client = MemWal.create({
  key: fresh.privateKeyHex,
  accountId: env.MEMWAL_ACCOUNT_ID,
  serverUrl: env.MEMWAL_SERVER_URL,
  namespace: "auth-probe",
});

for (const [label, call] of [
  ["health (unauthenticated)", () => client.health()],
  [
    "recall (authenticated)",
    () => client.recall({ query: "anything", namespace: "default", limit: 1 }),
  ],
] as const) {
  try {
    const out = await call();
    console.log(`  ${label}: ACCEPTED → ${JSON.stringify(out).slice(0, 120)}`);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    console.log(`  ${label}: rejected (${err.status ?? "?"}) ${String(err.message).slice(0, 90)}`);
  }
}
