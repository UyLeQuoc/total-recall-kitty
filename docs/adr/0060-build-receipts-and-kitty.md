# ADR-0060: Build Receipts (Track 1) and Kitty (Track 3) in this monorepo, on Remora's rails

- **Status:** Accepted
- **Date:** 2026-10-24
- **Deciders:** Uy

## Context
ideas/tracks-1-and-3.md drafted two more products:
- **Receipts** (Track 1): a group-chat pick'em with picks anchored on Sui and learned trust per voice;
- **Kitty** (Track 3): a group pot that pulls each share through native app-bound Allowances, after
  payday, and spends by group rules.

On Oct 24 Uy asked for both, in one goal he can run overnight. They live in this repo for now, split into
their own repos later, and reuse the current `.env` ("đưa goal chạy trong 1 lần đi, tách ra repo riêng
sau cũng được … xài lại env đi"; "làm cả 2 app luôn").

Whether either one is *entered* is a separate question. The rules allow one submission per person, and
Uy and Huấn are both on Remora.

## Decision
- **Layout:**
  - `apps/receipts` and `apps/kitty`: each has an API, a worker, a Telegram bot and a small web app;
  - `packages/move/receipts` (`receipts::anchor`) and `packages/move/kitty` (`kitty::pot`).
- **Separable by design:**
  - the apps import only workspace **packages** (`@remora/chain`, `@remora/memory`,
    `@remora/disc-sdk`, `@remora/sonar`, …);
  - code they need from `apps/server`, `apps/facilitator` or `apps/web` is copied, with a comment naming
    the source;
  - each app keeps its own Postgres schema (`receipts`, `kitty`) in the local dev database, its own copy
    and its own types;
  - nothing goes in `packages/schema`, and no Remora contract changes.
- **The env is reused as is** for the build:
  - the operator's Walrus Memory account, on the mainnet relayer, under the namespaces `receipts:*` and
    `kitty:*`;
  - the Tatum keys;
  - OpenRouter;
  - the testnet test keys (burner, sponsor, spike owner);
  - the test Telegram bot, **one poller at a time**.

  New keys (Kitty's keeper, its test members) are generated into `.env` and never committed or printed.
- **Networks:** money and Move are on testnet (ADR-0024); memory is on the mainnet relayer (ADR-0026).
  Tatum streams are filtered (ADR-0058).
- **Ownership:** Uy's lane (the CODEOWNERS default).
  - Feature ids: `RC*` for Receipts, `KT*` for Kitty.
  - The two Move packages each go through a PR. Uy's agent may merge them once CI is green, because Uy
    runs this goal unattended.
- **Not decided here:** entering Track 1 or Track 3. That needs the organizers' answer on multiple entries
  and a named owner and submitter per entry. Entering would supersede ADR-0001. Each entry would then
  get its own repo, Tatum account, Walrus Memory account (≥10 mainnet memories) and Telegram bot.

## Consequences
- No Remora path changes.
  - A shared package may only change backward compatibly, with tests.
  - Remora's full suite must stay green.
- Tonight the apps share the operator's relayer budget (~1000 weighted requests an hour) and the Tatum
  credits with Remora, so writes are batched and streams are filtered.
- Testnet SUI is short (about 0.32 SUI across the test keys on Oct 24), and the faucet API refuses this
  machine. Two publishes and the exits fit only if Uy tops up the burner, or if the goal stops its onchain
  steps when SUI runs out.

## Links
- ADR-0001 (Track 2 only), ADR-0003 and ADR-0020 (Disc on native Allowances), ADR-0021 (gRPC only),
  ADR-0024, ADR-0026, ADR-0058
- Ideas, U11 goal
