# ADR-0064: Receipts and Kitty: a React web with wallets is the main surface, Telegram is optional

- **Status:** Accepted
- **Date:** 2026-10-25
- **Deciders:** Uy

## Context
U11 built both apps with a server-rendered web (ADR-0061,
[ADR-0062](0062-kitty-pot-design.md)) and a Telegram bot. That web has no wallet:
- in Receipts, a visitor picks as any member by choosing a name;
- in Kitty, the server joins and approves with test members' keys it holds.

On Oct 25 Uy asked for the web to come first, not Telegram ("làm bản web đi, sao qua telegram nhỉ"). Given
three options, he chose a web app where people sign with their own wallet.

## Decision
- **Stack:** each app gets a web in `apps/<app>/web`, in the same package as its API:
  - Vite, React 19, Tailwind 4, TanStack Query and `@mysten/dapp-kit`, at the versions `apps/web` already
    uses, so the lockfile gains no new packages;
  - dev ports 5181 (Receipts) and 5182 (Kitty), proxying `/api` to 8811 and 8821;
  - a built web is served by the app's own server under the same paths as before (`/g/:id`, `/p/:pick`,
    `/pots/:id`, …), so one process serves one URL and the bots' links keep working.
- **Wallets:** dapp-kit on testnet, gRPC-web against `fullnode.testnet.sui.io`
  ([ADR-0021](0021-sui-grpc-only.md)). zkLogin waits for an Enoki key.
- **Kitty:**
  - Every member action (start a pot, join, propose, approve, leave) is a transaction signed by the
    member's own wallet, with gas sponsored.
    - The server builds the whole transaction with its existing builders: the wallet is the sender and
      the sponsor is the gas owner. It returns the bytes.
    - The wallet signs them. The server adds the sponsor's signature, executes the transaction and
      records it, exactly as before.
    - **The sponsor only ever signs transactions its own server built.**
  - The keeper's pulls stay on the server.
  - Pulls spend from the address balance. The web offers to move the wallet's USDC coins there, and it
    points to Circle's testnet faucet for test USDC.
- **Receipts:**
  - A member is a Sui address.
  - Joining a group and each pick are personal messages the wallet signs. The server verifies the
    signature and stores it with the pick, so a receipt proves who picked (the signature) and when (the
    anchor).
  - Members without a wallet (test members, Telegram users) still pick through the bot or the API, and
    the page says so.
- **The server-rendered pages are removed.** The servers keep the JSON API, the worker and the bot.
- **Telegram stays as a second channel** (alerts, quick commands, links to the web), and is off unless
  `*_BOT=on`.
- **Tests:**
  - unit tests cover the server side: building and finishing a sponsored transaction, and the
    signature checks;
  - each app has a Playwright run with an injected wallet-standard test wallet (the pattern in
    `e2e/support/test-wallet.ts`), signing with generated testnet keys only, never a real owner's
    wallet.

## Consequences
- This supersedes the **Web** parts of ADR-0061 and ADR-0062. Their other decisions stand.
- A sponsored transaction is held open between the build and the wallet's signature. Pending builds
  expire after 2 minutes, and a build that would abort is refused before any signature is asked for.
- The exit scripts that drove the old web forms move to the API or to Playwright. The U11 exit record
  stays as it ran.
- The apps still run locally only; there is no deploy (ADR-0060).

## Links
- [ADR-0060](0060-build-receipts-and-kitty.md), ADR-0061,
  [ADR-0062](0062-kitty-pot-design.md), [ADR-0021](0021-sui-grpc-only.md)
- `apps/web/src/app/providers.tsx` (the dapp-kit setup), `apps/web/src/features/connect/sponsor.ts`,
  `e2e/support/test-wallet.ts`
