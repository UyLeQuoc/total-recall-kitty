# ADR-0065: Split Receipts and Kitty into their own public repos

- **Status:** Accepted; the "no license yet" point is settled by ADR-0068 (MIT)
- **Date:** 2026-10-25
- **Deciders:** Uy

## Context
[ADR-0060](0060-build-receipts-and-kitty.md) built Receipts and Kitty in this monorepo, to be moved into
their own repos later. On Oct 25 Uy asked for the split ("tách repo ra nhỉ") and chose:
- the names `total-recall-*`;
- public repos;
- a fresh history;
- removing both apps from Remora afterwards.

## Decision
- **Repos:** `github.com/UyLeQuoc/total-recall-receipts` and `github.com/UyLeQuoc/total-recall-kitty`,
  public.
  - Each starts with one commit that names the Remora commit it was copied from. The full history stays
    here.
- **Layout:** the monorepo paths are kept, so commands, `.env` paths and CI read the same:
  - `apps/<app>` and `packages/move/<app>`;
  - `packages/chain` and `packages/memory`, copied as `@total-recall/chain` and `@total-recall/memory`.
    These are copies, not dependencies. Remora keeps its own.
- **Tooling:** Remora's root config is copied: the Bun 1.3.14 pin, the overrides
  (ADR-0057), the OSV install scanner, Biome and Turbo.
  - The lockfile is Remora's, pruned to what each repo uses, so no version moves.
  - Each repo has its own CI: lint, typecheck, test, build, audit, and `sui move test` for its package.
- **Database:** each repo has its own Postgres in `docker-compose.yml` (5435 for Receipts, 5436 for
  Kitty).
  - On this machine, `.env` keeps pointing at the existing dev database, so the data built so far carries
    over.
- **Docs:** the ADRs the code cites are copied under their Remora numbers: 0021, 0060, 0061 or 0062,
  0063, 0064 and this one. Links to docs that weren't copied become plain text.
- **Env:** the same values as now (ADR-0060). They are never committed. Each entry's own Tatum, Walrus
  Memory and bot accounts are still on the morning list.
- **Removal from Remora:** this happens in one commit, once two things are done:
  - Receipts' exit stage "after" has run here, against the worker that's already running;
  - both new repos are green.

  That commit deletes:
  - `apps/receipts` and `apps/kitty`;
  - `packages/move/receipts` and `packages/move/kitty`;
  - their CI lines and their `.env.example` names.

  Remora's docs then link to the new repos.
- **Kept as is:**
  - the testnet package ids;
  - the `UpgradeCap`s, which the spike owner key still holds;
  - the backward-compatible `dedupe` option in Remora's `@remora/memory` (ADR-0063).

## Consequences
- **Not an entry.** Making the repos public doesn't enter Track 1 or 3. That's still ADR-0060's open
  question.
- **The copies will drift.** `chain` and `memory` will diverge from Remora's. A fix in one is ported to
  the other by hand.
- **No license yet.** The repos are public without a `LICENSE` until Uy picks one. U9 recommends
  Apache-2.0 for Remora.
- **Nothing private goes public.** The repos hold no keys or `.env`, only testnet ids and test addresses.
  The copied ADRs keep their internal notes (the agent ran unattended overnight; whether to enter is
  undecided).

## Links
- [ADR-0060](0060-build-receipts-and-kitty.md), [ADR-0064](0064-receipts-kitty-web-with-wallets.md)
- The U11 exit record
