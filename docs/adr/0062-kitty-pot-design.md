# ADR-0062: Kitty: a Move pot on app-bound allowances, a keeper that checks balances first, and payday learning in memory

- **Status:** Accepted; the **Web** part is superseded by [ADR-0064](0064-receipts-kitty-web-with-wallets.md)
- **Date:** 2026-10-24
- **Deciders:** Uy's agent (U11, unattended; Uy reviews in the morning)

## Context
Kitty is the Track 3 app ([ADR-0060](0060-build-receipts-and-kitty.md)): a group pot that nobody holds.
Each share is pulled after the member's payday, never above the cap they set, and the pot spends only by
group rules. It has to be built overnight, on testnet, with the keys already in `.env`, and with no Enoki
key (so no zkLogin).

## Decision
- **Move: `kitty::pot`** (new package `packages/move/kitty`). App type `KITTY`, following the Disc's
  patterns: permit guards, a version field with `migrate`, an event for every money move.
  - `create`: a shared `Pot<C>` with name, goal, deadline, keeper, quorum and an auto-ok cap.
  - `join`: in the same PTB as `allowance::propose_for_app<Balance<C>, KITTY>`.
    - The spender must be the keeper.
    - One allowance per member, matched by `(funder, name)`.
    - The rate limit is the member's cap per window, and the expiry is the deadline.
    - **The money stays in the member's address balance until a pull.**
  - `contribute` (keeper only) uses `app_balance_spend`. Sui enforces the window cap, the expiry and the
    spender.
  - `propose_spend`, `propose_auto_ok_cap` and `propose_close`, then `approve` and `execute`.
    - Approvals count only active members.
    - The quorum is capped at the number of active members, so a group that shrank can still decide.
  - `spend_auto`: up to the cap the group voted for, and aborts above it.
  - `leave` revokes the member's allowance. What they put in stays, and comes back at close.
  - `close` (by vote, or by anyone after the deadline) refunds pro rata by contribution; the last
    contributor takes the rounding dust.
- **Keys and gas (testnet):**
  - A new `KITTY_KEEPER_KEY` is generated into `.env`. It's the spender of every member's allowance.
  - Test members' keys are generated into `.env` too (`KITTY_MEMBER_KEYS`, comma-separated) and labelled
    "test" wherever they show.
  - **Every transaction is sponsored** by `SPONSOR_PRIVATE_KEY_TESTNET`, so members and the keeper hold
    no SUI. The sponsor is never a member (ADR-0020's rule for Discs).
  - Money is Circle's testnet USDC, kept in address balances (ADR-0004).
- **The keeper checks before it pulls.**
  - It reads each member's address balance with Tatum gRPC `GetBalance`.
  - A member who can't cover the share gets **no transaction**, so no gas and no failed pull. A
    memory records the skip instead.
  - It watches the pot's members (≤10 addresses) with **one filtered `SubscribeCheckpoints` stream**
    (ADR-0058).
  - An inflow is a payday signal. It goes to memory, and that member's next pull happens right after it.
  - The reason cites the memory.
- **Amounts adapt.** Each pull is the member's fair share of what's left of the goal over the windows
  left, capped by their allowance. A member who is behind is noted in memory, and their share rises up to
  their cap.
- **Suggested rules.**
  - When the group has quickly approved ≥3 spends of one kind under an amount, Kitty writes a suggestion
    memory and offers "make it automatic up to $X?".
  - Accepting it is a `propose_auto_ok_cap` vote. The contract enforces the result; Kitty only suggests.
- **Memory** (operator account, mainnet relayer): `kitty:pot:<id>:members` for paydays, skips and
  adaptations, and `kitty:pot:<id>:norms` for approval patterns, suggestions and rule changes. Every
  action's reason cites a blob.
- **Web:** server-rendered Hono JSX, like Receipts (ADR-0061).
  - **Joining with one signature uses a labelled test member's key held by the server**, because
    there's no Enoki key for zkLogin.
  - A wallet join (dapp-kit) is the follow-up.
- **Process:** `apps/kitty` is its own workspace package, with its own Postgres schema (`kitty`) and port
  8821. The worker runs only with `KITTY_WORKER=on`, and the bot only with `KITTY_BOT=on`.

## Consequences
- A failed pull costs nothing, because it never happens: "no overdraft, no fee" is literally true.
- Paydays in two weeks of testnet are thin. The exit simulates one with a transfer from the spike owner,
  and the docs say so.
- Kitty and Remora share the allowance pattern (the Disc), but Kitty has no agent payments and no
  merchants. It's a consumer pot.

## Links
- ADR-0003, ADR-0004, ADR-0020 (allowances, address balances, the Disc), ADR-0021, ADR-0058, ADR-0060,
  ADR-0061
- Ideas: Kitty
