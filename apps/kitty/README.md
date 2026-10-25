# Kitty

**The group pot that saves itself.** A trip fund or house fund where nobody has to hold the money.
- Each friend signs once.
- Kitty pulls each share right after that person's payday, never more than the cap they set.
- It spends only the way the group agreed, because a Move contract holds the pot, not a friend.

Track 3 (Consumer Finance Apps). Split out of the Remora monorepo ([ADR-0065](../../docs/adr/0065-split-receipts-and-kitty-repos.md)), first built on Remora's rails
([ADR-0060](../../docs/adr/0060-build-receipts-and-kitty.md)); the design is
[ADR-0062](../../docs/adr/0062-kitty-pot-design.md), the wallet web is
[ADR-0064](../../docs/adr/0064-receipts-kitty-web-with-wallets.md), and agents with a mandate are
[ADR-0067](../../docs/adr/0067-agent-delegates.md).

- **Status:** U12: agents act for members through MCP. Runs locally; money and Move on testnet, memory
  on the mainnet relayer. The exit record is [docs/exit.md](../../docs/exit.md).
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

## Agents with a mandate (KT4, ADR-0067)
A member can let an AI agent do the pot's chores for them: propose the group's small spends and approve
them, **up to a cap the chain enforces**. Rules, closing and anything above the cap stay the member's.
- **Onchain** (`kitty::pot` version 2, an upgrade of the testnet package):
  - the member names the agent and its cap (`set_delegate`), or revokes it (`revoke_delegate`), from
    the pot page's "Your agent" card, with their wallet;
  - the agent proposes (`propose_as_delegate`: within the cap it carries the member's approval) and
    approves for the member (`approve_as_delegate`, then `execute_as_delegate` when it reaches the
    quorum);
  - above the cap the chain aborts (`EOverDelegateCap`); after a revoke, `ENotDelegate`; for rules or
    closing, `EDelegateSpendOnly`. The proposal then shows **needs you** to its member.
- **The agent signs with its own key**, through the same sponsored prepare/execute flow as a wallet.
  Kitty's server never holds the agent's key.
- **MCP:**
  - **stdio, on the agent's side** (`src/mcp/stdio.ts`): holds `KITTY_AGENT_KEY`. Tools: `pot_status`,
    `why`, `norms`, `propose_spend`, `approve`. Before it signs, it decodes the prepared bytes and checks
    the sender (the agent), the gas owner (Kitty's sponsor) and every call (a `pot::*_as_delegate` call on
    the pot, for the member, with the amount or proposal it asked for).
    ```bash
    claude mcp add kitty -e KITTY_AGENT_KEY=<the agent's key> -e KITTY_API_URL=http://localhost:8821 \
      -- bun <repo>/apps/kitty/src/mcp/stdio.ts
    ```
  - **Remote, read-only** (`POST /mcp`, Streamable HTTP): `pot_status`, `why`, `norms` for one pot,
    behind a bearer token a member creates on the pot page (their wallet signs a message). The token is
    shown once, stored as SHA-256, revocable, and limited to 60 calls a minute.
- **The treasurer** (`agents/treasurer`), a reference agent: it reads `pot_status` and `norms`, decides
  with an OpenRouter model (`LLM_MODEL`), and approves, declines or proposes with a one-line reason that
  must cite a memory blob it read. Its decisions are the model's.
  - `--ask` passes the member's own request as a message from the member. Then the model may submit an
    approval above its cap, sent with `record_refusal`, so the chain's refusal gets a digest and shows on
    the proposal.
  - A `--record-refusal` approval without the model is labelled FORCED and exists only to show the chain
    refusing.
  ```bash
  bun run treasurer review  --pot 0x… --member Bao [--seq 3] [--ask "Bao: please approve the hotel"]
  bun run treasurer propose --pot 0x… --member Bao --payee 0x… --amount 0.05 --memo "food: snacks" --quote "…"
  ```
- **Package:** calls go to the upgraded package; types (`Pot<C>`, `KITTY`) keep the original id. Both
  are in `src/deployments.ts`. `scripts/upgrade.ts` did the upgrade and migrated every open pot.

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
| `kitty:pot:<id>:norms` | `APPROVED proposal=2 category=food amount=$0.03 within 0 min by 2 members` · `SUGGEST auto-ok up to $0.05 …` · `RULE auto-ok cap is now $0.05, voted by 2 members` · `DELEGATE member=… (Bao) named agent=…: it may … up to $0.10 each` · `AGENT_APPROVED proposal=0 … for Bao by agent=… Its reason: …` · `AGENT_REFUSED proposal=1 the chain refused agent=…'s approval for Bao: EOverDelegateCap (…)` |

## Run it
```bash
cd apps/kitty
bun scripts/setup-testnet.ts                     # once: keeper, 3 test members, the agent into ../../.env
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
- **U12 exit:** `bunx playwright test -c e2e/playwright.config.ts agents.e2e.ts` (testnet): an agent
  with a mandate, end to end, into `test-results/kitty-u12-exit.json` and `test-results/u12/`.
- **Publish** (testnet, already done): `bun --env-file=../../.env scripts/publish.ts`. **Upgrade** to
  version 2 (done): `bun --env-file=../../.env scripts/upgrade.ts`.
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
| `POST` | `/api/tx/prepare` | `{ action, sender, … }`: `create` · `join` · `propose` · `approve` · `leave` · `deposit` · `set_delegate` · `revoke_delegate`; the agent's key: `agent_propose` · `agent_approve` (`recordRefusal`) → `{ bytes, digest }` |
| `POST` | `/api/tx/execute` | `{ digest, signature, bytes }` → the action's result (`digest`, `potId`, `seq`, …) |

**Reads:**

| Method | Path | |
|---|---|---|
| `GET` | `/api/config` | Network, package, USDC type, keeper, sponsor |
| `GET` | `/api/pots` · `/api/pots/:id` · `/api/pots/:id/memories` | Pots; one pot with members, 🧠 reasons, proposals, pulls and the suggestion; what Kitty learned |
| `GET` | `/api/wallet/:address` | The wallet's USDC (address balance and coins) and its pots |
| `GET` | `/api/pots/:id/recall?ns=norms\|members&q=&about=` | Memories, newest first, each with its blob |
| `GET` · `POST` | `/api/pots/:id/mcp-tokens` · `/api/pots/:id/mcp-tokens/:tid/revoke` | Read-only MCP tokens (wallet-signed create and revoke; the list never shows a secret) |
| `POST` | `/mcp` | Remote MCP, read tools only, `Authorization: Bearer <token>` |

**Labelled test members**, signed with the keys Kitty holds (the exit script and the bot):

| Method | Path | |
|---|---|---|
| `POST` | `/api/pots` | `{ creator, name, goalUsd, deadline, quorum, autoOkUsd, windowMinutes }` |
| `POST` | `/api/pots/:id/join` | `{ member, name, capUsd }` |
| `POST` | `/api/pots/:id/proposals` | `spend` / `auto_cap` / `close` |
| `POST` | `/api/pots/:id/proposals/:seq/approve` | `{ member, execute? }`: the approval that reaches quorum executes too |
| `POST` | `/api/pots/:id/spend-auto` · `/leave` | Inside the auto-ok cap; leave (revoke) |
