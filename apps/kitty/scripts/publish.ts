// KT1 (ADR-0062): publishes `packages/move/kitty` on TESTNET with the spike owner key, which keeps
// the UpgradeCap like the Disc's (ADR-0025), and writes the ids to `src/deployments.ts`.
//   bun --env-file=../../.env scripts/publish.ts
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Transaction } from "@mysten/sui/transactions";
import { createTatumSuiClient, tatumSuiOptionsFromEnv } from "@total-recall/chain";
import { keypairFrom } from "../src/keys.ts";

const here = dirname(fileURLToPath(import.meta.url));
const owner = keypairFrom(process.env.SPIKE_OWNER_KEY, "SPIKE_OWNER_KEY");
const client = createTatumSuiClient(tatumSuiOptionsFromEnv("testnet"));

const out = execFileSync("sui", ["move", "build", "--dump-bytecode-as-base64", "-e", "testnet"], {
  cwd: join(here, "../../../packages/move/kitty"),
  encoding: "utf8",
});
const { modules, dependencies } = JSON.parse(out.slice(out.indexOf("{")));
const tx = new Transaction();
tx.setSender(owner.toSuiAddress());
tx.transferObjects([tx.publish({ modules, dependencies })], owner.toSuiAddress());
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

const packageId = done.effects.changedObjects.find(
  (o) => o.outputState === "PackageWrite",
)?.objectId;
const upgradeCapId = done.effects.changedObjects.find(
  (o) =>
    o.idOperation === "Created" &&
    done.objectTypes?.[o.objectId]?.endsWith("::package::UpgradeCap"),
)?.objectId;
const file = `/** Written by scripts/publish.ts (KT1, ADR-0062). Testnet only; mainnet is Uy's call (ADR-0024). */
export const DEPLOYMENTS = {
  testnet: {
    packageId: "${packageId}",
    upgradeCapId: "${upgradeCapId}",
    publishDigest: "${done.digest}",
  },
} as const;
`;
writeFileSync(join(here, "../src/deployments.ts"), file);
console.log({ packageId, upgradeCapId, publishDigest: done.digest });
process.exit(0);
