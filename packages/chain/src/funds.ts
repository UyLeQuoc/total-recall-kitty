import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { withRetry } from "./retry.ts";

/** One address's balance of one coin type, split the way Detect funds shows it (ADR-0004). */
export interface FundsRead {
  coinType: string;
  total: bigint;
  /** In the address balance: what allowances and `tx.withdrawal` can spend. */
  addressBalance: bigint;
  /** In `Coin<T>` objects: needs `coin::send_funds` before allowances can use it. */
  coinBalance: bigint;
}

/**
 * `StateService.GetBalance` returns `address_balance` and `coin_balance` as separate fields, so one
 * call gives the split. There's no need to sum `ListOwnedObjects` coins.
 */
export async function readFunds(
  client: SuiGrpcClient,
  owner: string,
  coinType: string,
): Promise<FundsRead> {
  const { balance } = await withRetry(() => client.core.getBalance({ owner, coinType }));
  return {
    coinType: balance.coinType,
    total: BigInt(balance.balance),
    addressBalance: BigInt(balance.addressBalance),
    coinBalance: BigInt(balance.coinBalance),
  };
}
