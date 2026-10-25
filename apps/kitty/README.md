# Kitty

**The group pot that saves itself.** A trip fund or house fund where nobody has to hold the money.
- Each friend signs once.
- Kitty pulls each share right after that person's payday, never more than the cap they set.
- It spends only the way the group agreed, because a Move contract holds the pot, not a friend.

Track 3 (Consumer Finance Apps). Split out of the Remora monorepo ([ADR-0065](../../docs/adr/0065-split-receipts-and-kitty-repos.md)), first built on Remora's rails
([ADR-0060](../../docs/adr/0060-build-receipts-and-kitty.md)); the design is
[ADR-0062](../../docs/adr/0062-kitty-pot-design.md), the wallet web is
[ADR-0064](../../docs/adr/0064-receipts-kitty-web-with-wallets.md).

- **Status:** U11. Runs locally; money and Move on testnet, memory on the mainnet relayer.
- **Owner:** Uy (U11). Entering it as a submission isn't decided (ADR-0060).

## How it works
1. **Join with one signature.** One PTB creates a native app-bound allowance (`allowance::propose_for_app<Balance<USDC>, KITTY>` → `pot::join`):
   - its spender is the pot's keeper;
   - its rate limit is the member's cap per window, and it expires at the deadline;
   - **the money stays in the member's own address balance until a pull.**

   Gas is sponsored, so members hold no SUI.
2. **Pulls.**
   - The keeper reads the member's address balance first (Tatum gRPC `GetBalance`).
   - If it covers the share, the keeper pulls through `pot::contribute`, and Sui enforces the cap, the
     expiry and the spender.
   - **If it doesn't, no transaction is sent** (no overdraft, no fee), and a memory records the skip.
3. **Paydays.**
   - One `SubscribeCheckpoints` stream, filtered to the members (ADR-0058), sees money arriving.
   - That's a payday memory, and the member's next pull follows right after it, with a reason that
     cites the memory's blob.
4. **Amounts adapt.** A pull is the fair share of what's left over the windows left. A member behind
   plan gets a catch-up, never above their cap.
5. **Spending.**
   - `propose` → `approve` → `execute` at quorum. Approvals count only active members.
   - After three quick spends of one kind, Kitty suggests an auto-ok cap. The group votes it like any
     proposal, and `spend_auto` works only inside it.
6. **Leave and close.**
   - Leaving revokes the allowance, so no more pulls; what you put in stays.
   - Closing (by vote, or by anyone after the deadline) refunds pro rata.

## The web (ADR-0064, ADR-0066)
The web is the main surface; Telegram is optional. Members sign with **their own wallet** (dapp-kit on
testnet), and Kitty pays the gas. It uses Remora's design system (ADR-0066): its tokens, its shadcn kit
and its app shell, with a sidebar (a sheet on a phone), light and dark themes, and a "Connect wallet"
dialog.
- **Home:** the pots, "Start a pot" (the wallet creates it), and a "Get ready" card. Kitty pulls from the
  wallet's USDC **address balance**, so the card offers to move USDC coins there (one sponsored
  signature), or points to [Circle's testnet faucet](https://faucet.circle.com).
- **Pot page** (`/pots/:id`): progress, your status (join with one signature, or leave), members with
  their next pull and 🧠 reason (linking the Walrus blob), proposals with approve, Kitty's suggested
  auto-ok rule with "Propose it", and the keeper's pulls.
- **What Kitty learned** (`/pots/:id/learned`): every memory behind the reasons.

### How a wallet signs a sponsored transaction
1. The web posts what the member wants to `/api/tx/prepare` (`create`, `join`, `propose`, `approve`,
   `leave` or `deposit`), with the wallet's address.
2. The server runs the same action as for a test member (`src/actions.ts`), with a signer that stops at
   the signature (`src/wallet.ts`):
   - it builds the **whole** transaction: the member is the sender, the sponsor the gas owner and payer;
   - a build that would abort answers 409 with the contract's reason (`EUnderQuorum`, …), before any
     signature is asked for;
   - otherwise it answers with the bytes and their digest.
3. The wallet signs the bytes (`useSignTransaction`). The web posts the signature to `/api/tx/execute`.
4. The server checks that the signature signs those bytes as the sender, adds the sponsor's signature,
   executes, waits, and records the result (the mirror and memory) exactly as before.

**The sponsor only ever signs bytes its own server built.** An unsigned build expires after 2 minutes,
and nothing is sent. The approval that reaches quorum executes in the same transaction.

## Tatum (gRPC only, ADR-0021)
| Call | Where | Why |
|---|---|---|
| `GetBalance` | `src/keeper.ts` (`readFunds`) | Check the member's address balance before a pull |
| `SubscribeCheckpoints` (filtered, ≤10 addresses) | `src/watcher.ts` | Paydays: USDC arriving at a member |
| `GetCheckpoint` | `src/watcher.ts` | Backfill a short gap after a dropped stream (not after a re-subscribe) |
| `SimulateTransaction` · `ExecuteTransaction` · `GetTransaction` | `src/chain.ts` | Build (the SDK's resolve), send sponsored, wait |
| `GetObject` | `src/chain.ts` (`readPot`) | The pot's balance, totals and auto-ok cap |
| `ListCoins` · `GetReferenceGasPrice` | `src/chain.ts` | Gas data for a transaction sent without the dry run; the wallet's USDC coins to move into its balance |

The browser itself only talks gRPC-web to the public testnet fullnode, through dapp-kit.

## Memory (operator account, mainnet relayer)
| Namespace | Example |
|---|---|
| `kitty:pot:<id>:members` | `SKIP member=… (Chi) …: balance $0.05 < share $0.23, so no transaction and no fee; next pull waits for an inflow (payday)` · `PAYDAY member=… (Chi) received $0.50 …` · `PULLED … $0.23 right after Chi's payday … (memory <blob>)` |
| `kitty:pot:<id>:norms` | `APPROVED proposal=2 category=food amount=$0.03 within 0 min by 2 members` · `SUGGEST auto-ok up to $0.05 …` · `RULE auto-ok cap is now $0.05, voted by 2 members` |

## Run it
```bash
cd apps/kitty
bun scripts/setup-testnet.ts                     # once: keeper + 3 test members into ../../.env
npx drizzle-kit push                             # its own `kitty` schema, local DB only
KITTY_WORKER=on bun --env-file=../../.env src/main.ts   # the API on http://localhost:8821
bun run dev:web                                  # the web on http://localhost:5182 (/api → 8821)
# the bot: KITTY_BOT=on, only while no other poller uses TELEGRAM_BOT_TOKEN
```
- **One URL:** `bun run build` writes `web/dist`, and the server then serves the web itself on 8821, under
  the same paths (`/`, `/pots/:id`, `/pots/:id/learned`), so the bot's links work.
- **E2E:** `bun run e2e` (Playwright, testnet). It starts the API (no keeper stream, no bot) and the web,
  injects a wallet-standard test wallet signing with the generated test members' keys (never a real
  wallet), and runs: start a pot, two joins, a keeper pull, a proposal, the approval that pays it, a
  coin moved into a balance from the "Get ready" card, and a leave. The digests go to
  `test-results/kitty-e2e.json`, with screenshots. It's not part of `bun run test`.
  `e2e/screens.e2e.ts` runs with it and spends nothing: Home and a pot page, light and dark, at 1280 and
  375 px, into `test-results/screens/`.
- **Publish** (testnet, already done): `bun --env-file=../../.env scripts/publish.ts`.
- **Exit:** `bun --env-file=../../.env scripts/exit.ts`. It runs the keeper, the stream and the API in
  one process, with the test members' keys.
  - `exit.ts resume <pot> <step>` re-runs only a failed step.
  - `exit.ts overcap` and `exit.ts aborts` send the refusals as committed transactions.
  - `exit.ts api` checks the test-member endpoints (it was `web` while the pages were server-rendered).

## API
Amounts are USDC micro-dollars, as strings.

**The member's wallet signs** (the web):

| Method | Path | |
|---|---|---|
| `POST` | `/api/tx/prepare` | `{ action, sender, … }`: `create` · `join` · `propose` · `approve` · `leave` · `deposit` → `{ bytes, digest }` |
| `POST` | `/api/tx/execute` | `{ digest, signature, bytes }` → the action's result (`digest`, `potId`, `seq`, …) |

**Reads:**

| Method | Path | |
|---|---|---|
| `GET` | `/api/config` | Network, package, USDC type, keeper, sponsor |
| `GET` | `/api/pots` · `/api/pots/:id` · `/api/pots/:id/memories` | Pots; one pot with members, 🧠 reasons, proposals, pulls and the suggestion; what Kitty learned |
| `GET` | `/api/wallet/:address` | The wallet's USDC (address balance and coins) and its pots |

**Labelled test members**, signed with the keys Kitty holds (the exit script and the bot):

| Method | Path | |
|---|---|---|
| `POST` | `/api/pots` | `{ creator, name, goalUsd, deadline, quorum, autoOkUsd, windowMinutes }` |
| `POST` | `/api/pots/:id/join` | `{ member, name, capUsd }` |
| `POST` | `/api/pots/:id/proposals` | `spend` / `auto_cap` / `close` |
| `POST` | `/api/pots/:id/proposals/:seq/approve` | `{ member, execute? }`: the approval that reaches quorum executes too |
| `POST` | `/api/pots/:id/spend-auto` · `/leave` | Inside the auto-ok cap; leave (revoke) |
