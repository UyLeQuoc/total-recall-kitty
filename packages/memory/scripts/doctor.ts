/**
 * `bun run diagnose` — say what is configured, what works, and where the chain and
 * the relayer disagree.
 *
 * This is the tool we wished existed. A whole afternoon went into a
 * `MEMWAL_ACCOUNT_ID` that held the delegate public key instead of the account
 * object id, which mainnet silently repaired and testnet would have rejected
 * (docs/issues/05). It also surfaces the delegate mismatch from
 * docs/issues/08, so anyone running hippo can see for themselves whether the
 * relayer is honouring a key the chain does not list.
 *
 * Never prints a private key. Exits non-zero if something is actually broken,
 * so it can gate a deploy.
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { fromHex } from "@mysten/sui/utils";
import {
  createClient,
  createSuiClient,
  explorer,
  fetchRelayerConfig,
  findAccountIdForOwner,
  guestScope,
  loadEnv,
  operatorEnvSchema,
  RelayerExtras,
  readAccount,
  withoutBlanks,
} from "../src/index.ts";

loadEnv();

const ok = (m: string) => console.log(`  ok    ${m}`);
const warn = (m: string) => console.log(`  warn  ${m}`);
const bad = (m: string) => {
  console.log(`  FAIL  ${m}`);
  broken++;
};
let broken = 0;

console.log("\nEnvironment");
const parsed = operatorEnvSchema.safeParse(withoutBlanks(process.env));
if (!parsed.success) {
  for (const i of parsed.error.issues) bad(`${i.path.join(".")}: ${i.message}`);
  console.log("\nFix .env and run again. See .env.example.");
  process.exit(1);
}
const env = parsed.data;
ok(`relayer ${env.MEMWAL_SERVER_URL} (${env.SUI_NETWORK})`);
for (const [name, present] of [
  ["OPENROUTER_API_KEY", Boolean(process.env.OPENROUTER_API_KEY)],
  ["DATABASE_URL", Boolean(process.env.DATABASE_URL)],
  ["KEY_ENCRYPTION_KEY", /^[0-9a-fA-F]{64}$/.test(process.env.KEY_ENCRYPTION_KEY ?? "")],
  ["SESSION_SECRET", (process.env.SESSION_SECRET ?? "").length >= 32],
] as const) {
  present
    ? ok(`${name} set`)
    : warn(`${name} missing or malformed (needed to chat, not to read memory)`);
}
for (const [channel, token] of [
  ["telegram", process.env.TELEGRAM_BOT_TOKEN],
  ["discord", process.env.DISCORD_TOKEN],
  ["slack", process.env.SLACK_BOT_TOKEN],
] as const) {
  console.log(
    `  ${token ? "ok   " : "     "} channel ${channel}: ${token ? "configured" : "not configured"}`,
  );
}

console.log("\nRelayer");
const client = createClient(
  guestScope(
    {
      key: env.MEMWAL_PRIVATE_KEY,
      accountId: env.MEMWAL_ACCOUNT_ID,
      serverUrl: env.MEMWAL_SERVER_URL,
    },
    "doctor",
  ),
);
try {
  const health = await client.health();
  ok(`health ${health.status}, version ${health.version}`);
} catch (e) {
  bad(`unreachable: ${e instanceof Error ? e.message.slice(0, 80) : e}`);
}
const cfg = await fetchRelayerConfig(env.MEMWAL_SERVER_URL).catch(() => null);
if (!cfg) {
  warn("GET /config failed, falling back to MEMWAL_PACKAGE_ID");
} else if (cfg.packageId.toLowerCase() !== env.MEMWAL_PACKAGE_ID.toLowerCase()) {
  warn(`live package is ${cfg.packageId}, your MEMWAL_PACKAGE_ID says ${env.MEMWAL_PACKAGE_ID}`);
  warn("  the live value wins at runtime; the published docs are stale (docs/issues/04)");
} else {
  ok(`package ${cfg.packageId} matches /config`);
}

console.log("\nCredentials");
const operator = {
  key: env.MEMWAL_PRIVATE_KEY,
  accountId: env.MEMWAL_ACCOUNT_ID,
  serverUrl: env.MEMWAL_SERVER_URL,
};
const extras = new RelayerExtras(operator);
const delegatePub = await client.getPublicKeyHex();
const delegateAddr = Ed25519Keypair.fromSecretKey(fromHex(env.MEMWAL_PRIVATE_KEY))
  .getPublicKey()
  .toSuiAddress();
ok(`delegate public key ${delegatePub}  (this is MEMWAL_AGENT_ID on the submission form)`);
ok(`delegate address    ${delegateAddr}`);

let owner: string | null = null;
try {
  owner = (await extras.stats("default")).owner;
  ok(`relayer resolves owner ${owner}`);
} catch (e) {
  bad(`the relayer rejected these credentials: ${e instanceof Error ? e.message.slice(0, 80) : e}`);
}

if (owner) {
  const sui = createSuiClient(env.SUI_NETWORK);
  const expected = await findAccountIdForOwner(sui, env.MEMWAL_REGISTRY_ID, owner);
  if (!expected) {
    warn(`no MemWalAccount found on chain for ${owner}`);
  } else if (expected.toLowerCase() !== env.MEMWAL_ACCOUNT_ID.toLowerCase()) {
    bad(`MEMWAL_ACCOUNT_ID is wrong. On chain this owner's account is ${expected}`);
    warn("  mainnet repairs a wrong account id silently; testnet returns 401 (docs/issues/05)");
    warn(`  set MEMWAL_ACCOUNT_ID=${expected}`);
  } else {
    ok(`account ${env.MEMWAL_ACCOUNT_ID} matches the registry`);
    console.log(`        ${explorer.object(env.MEMWAL_ACCOUNT_ID)}`);
  }

  const account = await readAccount(sui, expected ?? env.MEMWAL_ACCOUNT_ID);
  if (!account) {
    warn("could not read the account object on chain");
  } else {
    ok(
      `account is ${account.active ? "active" : "FROZEN"}, ${account.delegates.length} delegate(s) on chain`,
    );
    const mine = account.delegates.some((d) => d.publicKeyHex === delegatePub.toLowerCase());
    if (mine) {
      ok("your delegate key is registered on chain");
    } else {
      warn("your delegate key is NOT in this account's on-chain delegate_keys.");
      warn("  Most likely MEMWAL_ACCOUNT_ID and MEMWAL_REGISTRY_ID name a different");
      warn("  Walrus Memory deployment than the one GET /config reports: two are live");
      warn("  on mainnet and the documented ids are the superseded pair. Check that the");
      warn("  registry object's Move type starts with the package below. docs/issues/11.");
    }
    try {
      const reported = (await extras.agents()).agents.length;
      if (reported !== account.delegates.length) {
        warn(
          `the relayer reports ${reported} delegates, the chain has ${account.delegates.length} (docs/issues/07)`,
        );
      } else {
        ok(`relayer and chain agree on ${reported} delegates`);
      }
    } catch {
      warn("GET /v1/owners/:owner/agents failed, which it does intermittently (docs/issues/07)");
    }
  }
}

console.log("\nStorage");
try {
  const all = await extras.allMemories();
  const withExpiry = all.filter((m) => m.expires_at);
  ok(`${all.length} memories visible on the read API`);
  if (withExpiry.length) {
    const soonest = withExpiry
      .map((m) => new Date(m.expires_at ?? 0).getTime())
      .sort((a, b) => a - b)[0];
    const days = Math.round(((soonest ?? 0) - Date.now()) / 86_400_000);
    days < 30
      ? warn(`soonest storage expiry is ${days} days away`)
      : ok(`soonest storage expiry is ${days} days away`);
  }
} catch (e) {
  warn(`read API unavailable: ${e instanceof Error ? e.message.slice(0, 60) : e}`);
}

console.log(broken === 0 ? "\nNothing broken.\n" : `\n${broken} problem(s) to fix.\n`);
process.exit(broken === 0 ? 0 : 1);
