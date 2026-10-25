/**
 * Sponsored account transactions, for Node.
 *
 * The browser has its own copy of this in `apps/web/src/features/connect/sponsor.ts`, driven
 * by a wallet. This one is driven by a keypair, so the owned-mode flow can be
 * exercised from a script without a person clicking through a wallet popup.
 *
 * The relayer sponsors exactly three calls, `account::create_account`,
 * `add_delegate_key` and `remove_delegate_key`, so the user pays no gas. That
 * is the whole reason onboarding can be one click.
 *
 * Sponsorship is not ours to rely on. When the relayer refuses, this falls back
 * to an ordinary transaction the keypair pays for, so a script can still
 * exercise owned mode. See docs/issues/11-sponsor-upstream-502.md.
 */

import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, fromHex, toBase64 } from "@mysten/sui/utils";
import { createSponsorAuthorization } from "@mysten-incubation/memwal";

const SUI_CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006";

export interface SponsorContext {
  relayerUrl: string;
  packageId: string;
  registryId: string;
  keypair: Ed25519Keypair;
  /** Any client that can build a transaction. */
  // biome-ignore lint/suspicious/noExplicitAny: the Sui client type varies by transport
  suiClient: any;
}

export interface ExecutionResult {
  digest: string;
  paidBy: "sponsor" | "self";
}

/**
 * Sponsored when the relayer will sponsor it, paid by the keypair when it will
 * not. `buildTx` is a factory because a built Transaction caches its data and
 * the fallback needs a clean one.
 */
export async function executeAccountTx(
  ctx: SponsorContext,
  buildTx: () => Transaction,
): Promise<ExecutionResult> {
  try {
    return { digest: await sponsorAndExecute(ctx, buildTx()), paidBy: "sponsor" };
  } catch (error) {
    const sender = ctx.keypair.getPublicKey().toSuiAddress();
    const tx = buildTx();
    tx.setSender(sender);
    const res = await ctx.suiClient.signAndExecuteTransaction({
      transaction: tx,
      signer: ctx.keypair,
    });
    await ctx.suiClient.waitForTransaction({ digest: res.transaction.digest });
    void error;
    return { digest: res.transaction.digest, paidBy: "self" };
  }
}

async function sponsorAndExecute(ctx: SponsorContext, tx: Transaction): Promise<string> {
  const sender = ctx.keypair.getPublicKey().toSuiAddress();
  const kindBytes = await tx.build({ client: ctx.suiClient, onlyTransactionKind: true });

  const auth = await createSponsorAuthorization(sender, kindBytes, async (message) => {
    const { signature } = await ctx.keypair.signPersonalMessage(message);
    return { signature };
  });

  const sponsored = await fetch(`${ctx.relayerUrl}/sponsor`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      transactionBlockKindBytes: toBase64(kindBytes),
      sender,
      ...auth,
    }),
  });
  if (!sponsored.ok) {
    throw new Error(`/sponsor ${sponsored.status}: ${(await sponsored.text()).slice(0, 200)}`);
  }
  const { bytes, digest } = (await sponsored.json()) as { bytes: string; digest: string };

  const { signature } = await ctx.keypair.signTransaction(fromBase64(bytes));

  const executed = await fetch(`${ctx.relayerUrl}/sponsor/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ digest, sender, signature }),
  });
  if (!executed.ok) {
    throw new Error(
      `/sponsor/execute ${executed.status}: ${(await executed.text()).slice(0, 200)}`,
    );
  }
  return ((await executed.json()) as { digest: string }).digest;
}

export function createAccountTx(ctx: SponsorContext): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${ctx.packageId}::account::create_account`,
    arguments: [tx.object(ctx.registryId), tx.object(SUI_CLOCK)],
  });
  return tx;
}

export function addDelegateKeyTx(
  ctx: SponsorContext,
  accountId: string,
  publicKeyHex: string,
  label: string,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${ctx.packageId}::account::add_delegate_key`,
    arguments: [
      tx.object(accountId),
      tx.object(ctx.registryId),
      tx.pure.vector("u8", Array.from(fromHex(publicKeyHex))),
      tx.pure.string(label),
      tx.object(SUI_CLOCK),
    ],
  });
  return tx;
}

export function removeDelegateKeyTx(
  ctx: SponsorContext,
  accountId: string,
  publicKeyHex: string,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${ctx.packageId}::account::remove_delegate_key`,
    arguments: [
      tx.object(accountId),
      tx.object(ctx.registryId),
      tx.pure.vector("u8", Array.from(fromHex(publicKeyHex))),
    ],
  });
  return tx;
}

export { sponsorAndExecute };
