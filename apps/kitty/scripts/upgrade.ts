// KT4 (ADR-0067): upgrades `kitty::pot` on TESTNET to version 2 (delegates), authorized by the
// UpgradeCap the spike owner key holds, then migrates every open pot in Kitty's database. Calls go to
// the new package id; types keep the original one. Both are written to `src/deployments.ts`.
//   bun --env-file=../../.env scripts/upgrade.ts
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Transaction } from "@mysten/sui/transactions";
import { createTatumSuiClient, tatumSuiOptionsFromEnv } from "@total-recall/chain";
import { eq } from "drizzle-orm";
import { addMigrate, readPot } from "../src/chain.ts";
import { createDb, pots } from "../src/db/index.ts";
import { DEPLOYMENTS } from "../src/deployments.ts";
import { keypairFrom } from "../src/keys.ts";

const VERSION = 2;
const here = dirname(fileURLToPath(import.meta.url));
const owner = keypairFrom(process.env.SPIKE_OWNER_KEY, "SPIKE_OWNER_KEY");
const client = createTatumSuiClient(tatumSuiOptionsFromEnv("testnet"));
const current: {
  packageId: string;
  upgradeCapId: string;
  publishDigest: string;
  originalPackageId?: string;
  version?: number;
  upgradeDigest?: string;
} = DEPLOYMENTS.testnet;
const original = current.originalPackageId ?? current.packageId;

async function execute(tx: Transaction) {
  tx.setSender(owner.toSuiAddress());
  const bytes = await tx.build({ client });
  const { signature } = await owner.signTransaction(bytes);
  const res = await client.core.executeTransaction({
    transaction: bytes,
    signatures: [signature],
    include: { effects: true, objectTypes: true },
  });
  const done = res.Transaction ?? res.FailedTransaction;
  if (!done.effects?.status.success) throw new Error(JSON.stringify(done.effects?.status.error));
  await client.core.waitForTransaction({ digest: done.digest });
  return done;
}

let packageId = current.packageId;
let upgradeDigest = current.upgradeDigest ?? "";
if ((current.version ?? 1) < VERSION) {
  const out = execFileSync("sui", ["move", "build", "--dump-bytecode-as-base64", "-e", "testnet"], {
    cwd: join(here, "../../../packages/move/kitty"),
    encoding: "utf8",
  });
  const { modules, dependencies, digest } = JSON.parse(out.slice(out.indexOf("{"))) as {
    modules: string[];
    dependencies: string[];
    digest: number[];
  };
  const tx = new Transaction();
  const cap = tx.object(current.upgradeCapId);
  const ticket = tx.moveCall({
    target: "0x2::package::authorize_upgrade",
    arguments: [cap, tx.pure.u8(0), tx.pure.vector("u8", digest)],
  });
  const receipt = tx.upgrade({ modules, dependencies, package: current.packageId, ticket });
  tx.moveCall({ target: "0x2::package::commit_upgrade", arguments: [cap, receipt] });
  const done = await execute(tx);
  const written = done.effects?.changedObjects.find(
    (o) => o.outputState === "PackageWrite" && o.objectId !== current.packageId,
  )?.objectId;
  if (!written) throw new Error(`no new package in ${done.digest}`);
  packageId = written;
  upgradeDigest = done.digest;
  writeFileSync(
    join(here, "../src/deployments.ts"),
    `/**
 * Written by scripts/publish.ts (KT1, ADR-0062) and scripts/upgrade.ts (KT4, ADR-0067). Testnet only;
 * mainnet is Uy's call (ADR-0024). Calls target \`packageId\`; types (\`Pot<C>\`, \`KITTY\`) keep
 * \`originalPackageId\`.
 */
export const DEPLOYMENTS = {
  testnet: {
    packageId: "${packageId}",
    originalPackageId: "${original}",
    version: ${VERSION},
    upgradeCapId: "${current.upgradeCapId}",
    publishDigest: "${current.publishDigest}",
    upgradeDigest: "${upgradeDigest}",
  },
} as const;
`,
  );
  console.log({ upgraded: packageId, original, upgradeDigest });
}

// Every open pot moves to version 2, so calls through the new package work on it.
const db = createDb(process.env.DATABASE_URL ?? "postgres://kitty:kitty@localhost:5436/kitty");
const open = await db.select().from(pots).where(eq(pots.closed, false));
const old: string[] = [];
for (const p of open) {
  const state = await readPot(client, p.id);
  if (state && !state.closed && state.version < VERSION) old.push(p.id);
}
const coinTypes = new Map(open.map((p) => [p.id, p.coinType]));
for (let i = 0; i < old.length; i += 20) {
  const tx = new Transaction();
  for (const id of old.slice(i, i + 20)) addMigrate(tx, packageId, coinTypes.get(id) ?? "", id);
  const done = await execute(tx);
  console.log({ migrated: old.slice(i, i + 20).length, digest: done.digest });
}
console.log({ open: open.length, migrated: old.length });
process.exit(0);
