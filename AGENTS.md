# Agent instructions: Kitty

Read `README.md`, then `apps/kitty/README.md` and `docs/adr/`.

- **Sui access is gRPC only** (ADR-0021). The server uses Tatum gRPC through `@total-recall/chain`; the
  browser uses gRPC-web. Never add JSON-RPC calls.
- **Money and Move run on testnet.** No mainnet transaction or publish, and no deploy, unless Uy asks.
- **Never commit `.env`, keys or tokens, and never print key values.** Test keys only, never a real owner's wallet.
- **Every checkpoint stream is filtered** (≤10 addresses). Run one bot poller per token.
- **Every decision gets an ADR** in `docs/adr/`, in the same commit. Never rewrite an accepted ADR;
  supersede it.
- **Before pushing:** `bun run lint && bun run typecheck && bun run test && bun run build`, plus
  `sui move test` when Move changes.
