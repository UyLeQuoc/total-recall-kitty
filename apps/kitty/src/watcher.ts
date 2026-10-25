/**
 * Paydays from the chain (KT2, ADR-0062): one `SubscribeCheckpoints` stream filtered to the members of
 * open pots (`affectedAddress` terms, at most 10, never unfiltered: ADR-0058). Copied in shape from
 * Remora's `apps/server/src/triggers/watch.ts`. A change in the watched set re-subscribes without
 * backfill; a dropped stream reconnects with backoff and backfills a short gap with `GetCheckpoint`.
 */
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { normalizeSuiAddress } from "@mysten/sui/utils";

export const MAX_FILTER_LITERALS = 10;

export interface WatchCheckpoint {
  sequenceNumber?: bigint;
  transactions: {
    digest?: string;
    balanceChanges?: { address?: string; coinType?: string; amount?: string }[];
  }[];
}

export interface Inflow {
  address: string;
  amount: bigint;
  digest: string;
}

/** Money arriving at a watched address, in `coinType` only. */
export function inflowsFrom(cp: WatchCheckpoint, watched: Set<string>, coinType: string): Inflow[] {
  const out: Inflow[] = [];
  for (const tx of cp.transactions) {
    for (const b of tx.balanceChanges ?? []) {
      if (!b.address || !b.amount || !b.coinType) continue;
      const address = normalizeSuiAddress(b.address);
      if (!watched.has(address) || !sameType(b.coinType, coinType)) continue;
      const amount = BigInt(b.amount);
      if (amount > 0n) out.push({ address, amount, digest: tx.digest ?? "" });
    }
  }
  return out;
}

const sameType = (a: string, b: string) => {
  const norm = (t: string) => {
    const [addr, ...rest] = t.split("::");
    return [normalizeSuiAddress(addr ?? ""), ...rest].join("::");
  };
  return norm(a) === norm(b);
};

export function filterFor(addresses: string[]) {
  if (addresses.length > MAX_FILTER_LITERALS)
    throw new Error(`a filter takes at most ${MAX_FILTER_LITERALS} addresses`);
  return {
    terms: addresses.map((address) => ({
      literals: [
        {
          negated: false,
          predicate: { oneofKind: "affectedAddress" as const, affectedAddress: { address } },
        },
      ],
    })),
  };
}

export function startWatcher(o: {
  client: SuiGrpcClient;
  coinType: string;
  addresses: () => Promise<string[]>;
  onInflow: (i: Inflow, checkpoint: number) => Promise<unknown>;
  log: (msg: string, data?: Record<string, unknown>) => void;
  refreshMs?: number;
  maxBackfill?: number;
}): () => void {
  let stopped = false;
  let last: bigint | null = null;
  let abort: AbortController | null = null;
  const READ_MASK = {
    paths: ["sequence_number", "transactions.digest", "transactions.balance_changes"],
  };

  const deliver = async (cp: WatchCheckpoint, watched: Set<string>, checkpoint: number) => {
    for (const i of inflowsFrom(cp, watched, o.coinType)) {
      await o
        .onInflow(i, checkpoint)
        .catch((err) => o.log("watcher.inflow_failed", { error: String(err) }));
    }
  };

  const loop = async () => {
    let delay = 1_000;
    let failed = false;
    while (!stopped) {
      const list = [
        ...new Set((await o.addresses().catch(() => [])).map((a) => normalizeSuiAddress(a))),
      ];
      const watched = list.slice(0, MAX_FILTER_LITERALS);
      if (list.length > watched.length)
        o.log("watcher.capped", { dropped: list.length - watched.length });
      if (!watched.length) {
        await new Promise((r) => setTimeout(r, o.refreshMs ?? 30_000));
        continue;
      }
      const key = watched.sort().join(",");
      const session = new AbortController();
      abort = session;
      const refresh = setInterval(async () => {
        const next = [
          ...new Set((await o.addresses().catch(() => list)).map((a) => normalizeSuiAddress(a))),
        ]
          .slice(0, MAX_FILTER_LITERALS)
          .sort()
          .join(",");
        if (next !== key) session.abort();
      }, o.refreshMs ?? 30_000);
      const set = new Set(watched);
      // Backfill only after a failure: a re-subscribe because the set changed starts at the tip (ADR-0058).
      const backfillFrom = failed ? last : null;
      try {
        o.log("watcher.subscribed", { addresses: watched.length });
        const call = o.client.subscriptionService.subscribeCheckpoints(
          { readMask: READ_MASK, filter: filterFor(watched) },
          { abort: session.signal },
        );
        let first = true;
        for await (const frame of call.responses) {
          if (stopped) break;
          const cursor = frame.cursor ?? 0n;
          if (
            first &&
            backfillFrom !== null &&
            cursor > backfillFrom + 1n &&
            cursor - backfillFrom <= BigInt(o.maxBackfill ?? 50)
          ) {
            for (let s = backfillFrom + 1n; s < cursor; s++) {
              const { response } = await o.client.ledgerService.getCheckpoint({
                checkpointId: { oneofKind: "sequenceNumber", sequenceNumber: s },
                readMask: READ_MASK,
              });
              if (response.checkpoint)
                await deliver(response.checkpoint as unknown as WatchCheckpoint, set, Number(s));
            }
          }
          first = false;
          if (frame.checkpoint)
            await deliver(frame.checkpoint as unknown as WatchCheckpoint, set, Number(cursor));
          if (last === null || cursor > last) last = cursor;
          delay = 1_000;
          failed = false;
        }
        if (!session.signal.aborted && !stopped) throw new Error("the checkpoint stream ended");
      } catch (err) {
        if (stopped) break;
        if (!session.signal.aborted) {
          failed = true;
          o.log("watcher.reconnect", { error: String(err), inMs: delay });
          await new Promise((r) => setTimeout(r, delay));
          delay = Math.min(delay * 2, 60_000);
        }
      } finally {
        clearInterval(refresh);
      }
    }
  };
  void loop();
  return () => {
    stopped = true;
    abort?.abort();
  };
}
