# ADR-0021: Sui chain access is gRPC only

- **Status:** Accepted
- **Date:** 2026-10-18
- **Deciders:** Uy Le

## Context
Checks on Oct 18:

- Sui's public fullnodes now reject JSON-RPC: "JSON-RPC on public fullnodes has been deprecated. Please
  migrate to gRPC or GraphQL".
- Tatum has **no Sui testnet JSON-RPC** (`sui-testnet.gateway.tatum.io` returns 404). It exposes gRPC
  for both networks.
- Tatum's gRPC is **native gRPC** (`application/grpc`), while `@mysten/sui`'s `SuiGrpcClient` defaults
  to gRPC-web.

The owner decided: use gRPC only.

## Decision
- **All Sui reads and writes use gRPC.** No JSON-RPC anywhere, and this supersedes the JSON-RPC parts
  of ADR-0015.
  - **Server side (Node):** Tatum gRPC, `https://sui-<network>-grpc.gateway.tatum.io` with an
    `x-api-key` header, through a **native gRPC transport** (e.g. `@protobuf-ts/grpc-transport` +
    `@grpc/grpc-js`) plugged into `SuiGrpcClient`. U1 verifies the exact wiring.
  - **Browser:** gRPC-web against a gRPC-web endpoint (public fullnode), or through our own API. Owner
    wallet transactions are built and executed with `SuiGrpcClient` (gRPC-web).
- **Mapping** from the old JSON-RPC plan to gRPC v2 services:
  | Need | gRPC |
  |---|---|
  | Simulate (was dry-run) | `TransactionExecutionService.SimulateTransaction` |
  | Execute / settle | `TransactionExecutionService.ExecuteTransaction` |
  | Transaction + events by digest | `LedgerService.GetTransaction` |
  | Objects (allowance, Disc, UpgradeCap) | `LedgerService.GetObject` / `BatchGetObjects` |
  | Balances (coins + address balance) | `StateService.GetBalance` / `ListBalances` |
  | Owned objects, coin info, dynamic fields | `StateService.ListOwnedObjects` / `GetCoinInfo` / `ListDynamicFields` |
  | Live chain events, triggers, indexing | `SubscriptionService.SubscribeCheckpoints` |
  | SuiNS | `NameService.LookupName` / `ReverseLookupName` |
- **There's no gRPC "query events by type" or "transactions by address".** History, such as `Paid`
  events or payments to a merchant, comes from **our own indexer**, fed by the checkpoint subscription
  and stored in Postgres. Verification fetches transactions by digest.

## Consequences
- `packages/chain` is a gRPC client (with native transport for Node) plus the Tatum Data API (HTTP).
- `.env.example`: `TATUM_SUI_GRPC` (+ `TATUM_SUI_GRPC_TESTNET`). There's no JSON-RPC URL.
  `Deployment.tatumSuiRpc` is removed from `packages/schema`.
- The indexer has to start before the data it needs exists. There's no backfill beyond what the
  subscription has seen.
- The docs (spec §5, §7, §11, §12.6; the tech reference; the features doc; the plan; the U1 goal) now
  name gRPC services instead of JSON-RPC methods.

## Links
- ADR-0015 · tech-reference.md §2.2
- https://docs.tatum.io/docs/sui-migration-guide-from-json-rpc-to-grpc
