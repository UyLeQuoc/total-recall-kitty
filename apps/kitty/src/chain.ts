/**
 * Kitty's transactions (KT2, ADR-0062). Sui access is Tatum gRPC only (ADR-0021). Every transaction is
 * sponsored by the testnet sponsor, so members and the keeper never hold SUI; the sponsor is never a
 * member.
 */
import { bcs } from "@mysten/sui/bcs";
import type { Keypair } from "@mysten/sui/cryptography";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction, type TransactionArgument } from "@mysten/sui/transactions";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { isValidTransactionSignature } from "@mysten/sui/verify";
import { createTatumSuiClient, readFunds } from "@total-recall/chain";

export const CLOCK = "0x6";
/** 0.05 SUI: plenty for any Kitty call, and the sponsor's cap for a transaction sent without a dry run. */
const SEND_GAS_BUDGET = 50_000_000n;

export function testnetClient(env: {
  TATUM_API_KEY_TESTNET?: string;
  TATUM_SUI_GRPC_TESTNET?: string;
}) {
  if (!env.TATUM_API_KEY_TESTNET) throw new Error("TATUM_API_KEY_TESTNET is not set");
  return createTatumSuiClient({
    network: "testnet",
    apiKey: env.TATUM_API_KEY_TESTNET,
    ...(env.TATUM_SUI_GRPC_TESTNET ? { url: env.TATUM_SUI_GRPC_TESTNET } : {}),
  });
}

export interface Executed {
  digest: string;
  success: boolean;
  error: string | null;
  created: { id: string; type: string }[];
  events: { type: string; bcs: Uint8Array }[];
}

/** A Move abort as the chain reports it, e.g. `EUnderQuorum` or `EExceedsRateLimit`. */
export class ChainAbort extends Error {
  constructor(
    readonly digest: string | null,
    readonly detail: string,
  ) {
    super(detail);
  }
  /** The abort's constant, e.g. `EUnderQuorum`, when the chain named one. */
  get code(): string | null {
    return /\b(E[A-Z][a-z][A-Za-z0-9]*)\b/.exec(this.detail)?.[1] ?? null;
  }
}

/** The wallet's signature doesn't sign the bytes Kitty built, or isn't the sender's. */
export class BadSignature extends Error {}

/**
 * Who signs as the sender. A local `Keypair` (the keeper, the labelled test members) is one; so is a
 * member's wallet, through the web (ADR-0064, `wallet.ts`).
 */
export interface Signer {
  toSuiAddress(): string;
  signTransaction(bytes: Uint8Array): Promise<{ signature: string }>;
}

export interface KittyChain {
  readonly client: SuiGrpcClient;
  readonly packageId: string;
  readonly coinType: string;
  readonly sponsor: string;
  /**
   * Builds, signs as `signer` + the sponsor, executes and waits. Normally the build's dry run refuses
   * a transaction that would abort (`ChainAbort`, no digest, no gas). `send: true` sends it anyway, so
   * the chain records the abort as a failed transaction with a digest (the sponsor pays its gas).
   *
   * The sponsor signs only the bytes built here, after the sender's signature checks out against them:
   * a wallet can sign, but never choose what the sponsor pays for.
   */
  run(
    signer: Signer,
    build: (tx: Transaction) => void,
    opts?: { send?: boolean },
  ): Promise<Executed>;
  usdcAddressBalance(owner: string): Promise<bigint>;
}

export function createChain(o: {
  client: SuiGrpcClient;
  sponsor: Keypair;
  packageId: string;
  coinType: string;
}): KittyChain {
  return {
    client: o.client,
    packageId: o.packageId,
    coinType: o.coinType,
    sponsor: o.sponsor.toSuiAddress(),
    async run(signer, build, opts) {
      let tx = new Transaction();
      tx.setSender(signer.toSuiAddress());
      tx.setGasOwner(o.sponsor.toSuiAddress());
      build(tx);
      let bytes: Uint8Array;
      try {
        if (opts?.send) {
          // The SDK's resolver simulates and refuses to build what would abort. With the kind built
          // alone and the gas data given in full, it doesn't, so the chain itself rejects it.
          const kind = await tx.build({ client: o.client, onlyTransactionKind: true });
          tx = Transaction.fromKind(kind);
          tx.setSender(signer.toSuiAddress());
          tx.setGasOwner(o.sponsor.toSuiAddress());
          tx.setGasBudget(SEND_GAS_BUDGET);
          const { referenceGasPrice } = await o.client.core.getReferenceGasPrice();
          tx.setGasPrice(BigInt(referenceGasPrice));
          const { objects } = await o.client.core.listCoins({
            owner: o.sponsor.toSuiAddress(),
            coinType: "0x2::sui::SUI",
          });
          const coin = [...objects].sort((a, b) =>
            Number(BigInt(b.balance) - BigInt(a.balance)),
          )[0];
          if (!coin) throw new Error("the sponsor has no SUI coins");
          tx.setGasPayment([
            { objectId: coin.objectId, version: coin.version, digest: coin.digest },
          ]);
        }
        bytes = await tx.build({ client: o.client });
      } catch (err) {
        // The build's dry run is the chain's Move VM refusing it: an abort, with nothing sent.
        if (
          (err as Error).name === "SimulationError" ||
          /MoveAbort|resolution failed/.test(String(err))
        ) {
          throw new ChainAbort(null, String((err as Error).message ?? err));
        }
        throw err;
      }
      const { signature } = await signer.signTransaction(bytes);
      if (
        !(await isValidTransactionSignature(bytes, signature, {
          client: o.client,
          address: signer.toSuiAddress(),
        }))
      ) {
        throw new BadSignature("The signature doesn't sign this transaction as its sender.");
      }
      const sponsored = await o.sponsor.signTransaction(bytes);
      // Not retried blindly: an UNAVAILABLE after submission can still land (packages/chain retry.ts).
      const res = await o.client.core.executeTransaction({
        transaction: bytes,
        signatures: [signature, sponsored.signature],
        include: { effects: true, events: true, objectTypes: true },
      });
      const done = res.Transaction ?? res.FailedTransaction;
      await o.client.core.waitForTransaction({ digest: done.digest }).catch(() => {});
      const success = !!done.effects?.status.success;
      const created = (done.effects?.changedObjects ?? [])
        .filter((c) => c.idOperation === "Created")
        .map((c) => ({ id: c.objectId, type: done.objectTypes?.[c.objectId] ?? "" }));
      const out: Executed = {
        digest: done.digest,
        success,
        error: success ? null : describe(done.effects?.status.error),
        created,
        events: (done.events ?? []).map((e) => ({ type: e.eventType, bcs: e.bcs })),
      };
      if (!success) throw new ChainAbort(done.digest, out.error ?? "failed");
      return out;
    },
    async usdcAddressBalance(owner) {
      return (await readFunds(o.client, owner, o.coinType)).addressBalance;
    },
  };
}

function describe(error: unknown): string {
  if (!error) return "unknown error";
  const s = JSON.stringify(error, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  return s.length > 600 ? `${s.slice(0, 600)}…` : s;
}

// ---------- builders (pure, so tests can inspect them) ----------

const pot = (pkg: string, fn: string) => `${pkg}::pot::${fn}`;

export function addCreate(
  tx: Transaction,
  pkg: string,
  coinType: string,
  a: {
    name: string;
    goal: bigint;
    deadlineMs: number;
    keeper: string;
    quorum: number;
    autoOkCap: bigint;
  },
) {
  tx.moveCall({
    target: pot(pkg, "create"),
    typeArguments: [coinType],
    arguments: [
      tx.pure.string(a.name),
      tx.pure.u64(a.goal),
      tx.pure.u64(a.deadlineMs),
      tx.pure.address(a.keeper),
      tx.pure.u64(a.quorum),
      tx.pure.u64(a.autoOkCap),
    ],
  });
}

/** `propose_for_app<Balance<C>, KITTY>` → `pot::join`, in one PTB: the member's one signature. */
export function addJoin(
  tx: Transaction,
  pkg: string,
  coinType: string,
  a: {
    potId: string;
    allowanceName: string;
    keeper: string;
    capPerWindow: bigint;
    windowMs: number;
    expiryMs: number;
  },
) {
  const typeArguments = ["0x2::allowance::RateLimit"];
  const limit = tx.moveCall({
    target: "0x2::allowance::periodic_rate_limit",
    arguments: [tx.pure.u64(a.windowMs), tx.pure.u256(a.capPerWindow)],
  });
  const rate = tx.moveCall({ target: "0x1::option::some", typeArguments, arguments: [limit] });
  const proposal = tx.moveCall({
    target: "0x2::allowance::propose_for_app",
    typeArguments: [`0x2::balance::Balance<${coinType}>`, `${pkg}::pot::KITTY`],
    arguments: [
      tx.pure.string(a.allowanceName),
      tx.pure.address(a.keeper),
      tx.pure(bcs.option(bcs.u256()).serialize(null)),
      tx.pure(bcs.option(bcs.u64()).serialize(null)),
      tx.pure(bcs.option(bcs.u64()).serialize(a.expiryMs)),
      rate,
    ],
  });
  tx.moveCall({
    target: pot(pkg, "join"),
    typeArguments: [coinType],
    arguments: [tx.object(a.potId), proposal],
  });
}

/** Keeper: pull `amount` from `member`'s address balance through their allowance. */
export function addContribute(
  tx: Transaction,
  pkg: string,
  coinType: string,
  a: { potId: string; allowanceId: string; member: string; amount: bigint },
) {
  const w = tx.withdrawal({
    from: "allowance",
    allowance: a.allowanceId,
    funder: a.member,
    amount: a.amount,
    type: coinType,
  });
  tx.moveCall({
    target: pot(pkg, "contribute"),
    typeArguments: [coinType],
    arguments: [tx.object(a.potId), tx.object(a.allowanceId), w, tx.object(CLOCK)],
  });
}

export function addPropose(
  tx: Transaction,
  pkg: string,
  coinType: string,
  potId: string,
  p:
    | { kind: "spend"; payee: string; amount: bigint; memo: string }
    | { kind: "auto_cap"; cap: bigint }
    | { kind: "close" },
) {
  const args: TransactionArgument[] = [tx.object(potId)];
  if (p.kind === "spend") {
    args.push(tx.pure.address(p.payee), tx.pure.u64(p.amount), tx.pure.string(p.memo));
    tx.moveCall({ target: pot(pkg, "propose_spend"), typeArguments: [coinType], arguments: args });
  } else if (p.kind === "auto_cap") {
    args.push(tx.pure.u64(p.cap));
    tx.moveCall({
      target: pot(pkg, "propose_auto_ok_cap"),
      typeArguments: [coinType],
      arguments: args,
    });
  } else {
    tx.moveCall({ target: pot(pkg, "propose_close"), typeArguments: [coinType], arguments: args });
  }
}

export function addApprove(
  tx: Transaction,
  pkg: string,
  coinType: string,
  potId: string,
  seq: number,
  execute = false,
) {
  tx.moveCall({
    target: pot(pkg, "approve"),
    typeArguments: [coinType],
    arguments: [tx.object(potId), tx.pure.u64(seq)],
  });
  if (execute) addExecute(tx, pkg, coinType, potId, seq);
}

export function addExecute(
  tx: Transaction,
  pkg: string,
  coinType: string,
  potId: string,
  seq: number,
) {
  tx.moveCall({
    target: pot(pkg, "execute"),
    typeArguments: [coinType],
    arguments: [tx.object(potId), tx.pure.u64(seq)],
  });
}

export function addSpendAuto(
  tx: Transaction,
  pkg: string,
  coinType: string,
  a: { potId: string; payee: string; amount: bigint; memo: string },
) {
  tx.moveCall({
    target: pot(pkg, "spend_auto"),
    typeArguments: [coinType],
    arguments: [
      tx.object(a.potId),
      tx.pure.address(a.payee),
      tx.pure.u64(a.amount),
      tx.pure.string(a.memo),
    ],
  });
}

export function addLeave(
  tx: Transaction,
  pkg: string,
  coinType: string,
  a: { potId: string; allowanceCapId: string; allowanceId: string },
) {
  tx.moveCall({
    target: pot(pkg, "leave"),
    typeArguments: [coinType],
    arguments: [tx.object(a.potId), tx.object(a.allowanceCapId), tx.object(a.allowanceId)],
  });
}

/** `coin::redeem_funds` from the sender's address balance → `coin::send_funds` into `to`'s. */
export function addSendUsdc(tx: Transaction, coinType: string, to: string, amount: bigint) {
  const coin = tx.moveCall({
    target: "0x2::coin::redeem_funds",
    typeArguments: [coinType],
    arguments: [tx.withdrawal({ amount, type: coinType })],
  });
  tx.moveCall({
    target: "0x2::coin::send_funds",
    typeArguments: [coinType],
    arguments: [coin, tx.pure.address(to)],
  });
}

/**
 * "Move to my Kitty balance" (ADR-0004): merge the owner's USDC coins and `send_funds` them to the
 * owner's own address balance, where the keeper's allowance pulls from.
 */
export function addDepositCoins(
  tx: Transaction,
  coinType: string,
  owner: string,
  coinIds: string[],
) {
  const [first, ...rest] = coinIds.map((id) => tx.object(id));
  if (!first) throw new Error("no coins to move");
  if (rest.length) tx.mergeCoins(first, rest);
  tx.moveCall({
    target: "0x2::coin::send_funds",
    typeArguments: [coinType],
    arguments: [first, tx.pure.address(owner)],
  });
}

/** Every coin object of `coinType` the owner holds (Tatum gRPC `ListOwnedObjects`). */
export async function coinIds(client: SuiGrpcClient, owner: string, coinType: string) {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await client.core.listCoins({ owner, coinType, ...(cursor ? { cursor } : {}) });
    ids.push(...page.objects.map((o) => o.objectId));
    cursor = page.hasNextPage ? page.cursor : null;
  } while (cursor && ids.length < 200);
  return ids;
}

// ---------- reading the pot ----------

export interface PotState {
  balance: bigint;
  totalIn: bigint;
  totalOut: bigint;
  autoOkCap: bigint;
  closed: boolean;
}

/** The fields the web shows, from the object's JSON (Tatum gRPC `GetObject`). */
export async function readPot(client: SuiGrpcClient, potId: string): Promise<PotState | null> {
  const res = await client.core
    .getObject({ objectId: potId, include: { json: true } } as never)
    .catch(() => null);
  const json = (res as { object?: { json?: Record<string, unknown> } } | null)?.object?.json;
  if (!json) return null;
  const big = (v: unknown) => BigInt(String((v as { value?: unknown })?.value ?? v ?? 0));
  return {
    balance: big(json.balance),
    totalIn: big(json.total_in),
    totalOut: big(json.total_out),
    autoOkCap: big(json.auto_ok_cap),
    closed: !!json.closed,
  };
}

export const explorerTx = (digest: string) => `https://suiscan.xyz/testnet/tx/${digest}`;
export const same = (a: string, b: string) => normalizeSuiAddress(a) === normalizeSuiAddress(b);
/** USDC has 6 decimals. */
export const usd = (micro: bigint) => `$${(Number(micro) / 1e6).toFixed(2)}`;
export const micro = (dollars: number) => BigInt(Math.round(dollars * 1e6));
