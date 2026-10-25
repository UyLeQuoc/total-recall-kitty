# packages/move/kitty

The `kitty` Move package (KT1, [ADR-0062](../../../docs/adr/0062-kitty-pot-design.md)) for the Kitty app (`apps/kitty`): a group pot that nobody holds.

- Each member joins with one signature: an app-bound allowance (app type `KITTY`) whose spender is the pot's keeper and whose rate limit is that member's cap per window. The money stays in their address balance until a pull.
- `contribute` (keeper only) pulls through `app_balance_spend`, so Sui enforces the cap, the expiry and the spender.
- Spends and rule changes go through `propose_*` → `approve` → `execute` at quorum. `spend_auto` works up to the cap the group voted for.
- `leave` revokes a member's allowance. `close` (by vote, or by anyone after the deadline) refunds pro rata.

- **Owner:** Uy Le (`@UyLeQuoc`), U11 ([ADR-0060](../../../docs/adr/0060-build-receipts-and-kitty.md))
- **Status:** v1. `sui move test` runs 21 tests: every path and every abort, rounding, versions. Published on testnet; the ids are in `apps/kitty/src/deployments.ts`.
- **Toolchain:** Sui CLI 1.82.1; the framework is pinned in `Move.lock` to testnet's (the newer `new_withdrawal_for_testing` takes a `Withdrawal`).
- **Publish (testnet only):** `bun --env-file=.env apps/kitty/scripts/publish.ts`. Mainnet is Uy's call (ADR-0024).
