/** Wires Kitty from the env: chain (sponsored), keeper, test members' keys, memory, database. */
import { normalizeSuiAddress } from "@mysten/sui/utils";
import type { ActionDeps } from "./actions.ts";
import { createChain, testnetClient } from "./chain.ts";
import { createDb } from "./db/index.ts";
import { DEPLOYMENTS } from "./deployments.ts";
import type { Env } from "./env.ts";
import { keypairFrom } from "./keys.ts";
import { createKittyMemory } from "./memory.ts";

export function wire(env: Env, log: (msg: string, data?: Record<string, unknown>) => void) {
  const db = createDb(env.DATABASE_URL);
  const client = testnetClient(env);
  const sponsor = keypairFrom(env.SPONSOR_PRIVATE_KEY_TESTNET, "SPONSOR_PRIVATE_KEY_TESTNET");
  const keeper = keypairFrom(env.KITTY_KEEPER_KEY, "KITTY_KEEPER_KEY");
  const chain = createChain({
    client,
    sponsor,
    packageId: env.KITTY_PACKAGE_ID ?? DEPLOYMENTS.testnet.packageId,
    coinType: env.USDC_COIN_TYPE_TESTNET,
  });
  const keys = new Map(
    (env.KITTY_MEMBER_KEYS ?? "")
      .split(",")
      .filter(Boolean)
      .map((k) => {
        const kp = keypairFrom(k, "KITTY_MEMBER_KEYS");
        return [normalizeSuiAddress(kp.toSuiAddress()), kp] as const;
      }),
  );
  const memory =
    env.MEMWAL_ACCOUNT_ID && env.MEMWAL_PRIVATE_KEY
      ? createKittyMemory(db, {
          key: env.MEMWAL_PRIVATE_KEY,
          accountId: env.MEMWAL_ACCOUNT_ID,
          serverUrl: env.MEMWAL_SERVER_URL,
        })
      : null;
  const ours = new Set<string>();
  const deps: ActionDeps = { db, chain, memory, keys, log, ours };
  return { ...deps, client, keeper, ours };
}
