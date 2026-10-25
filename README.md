# Kitty

**The group pot that saves itself.** A trip fund or house fund where nobody has to hold the money. Each friend signs once with their own wallet. Kitty pulls each share right after that person's payday through Sui's native app-bound allowances, never more than the cap they set, and spends only the way the group agreed, because a Move contract holds the pot.

Built for the Walrus × Tatum **Total Recall** hackathon, Track 3 (Consumer Finance Apps). Sui runs on testnet, the memory is
[Walrus Memory](https://memory.walrus.xyz) on mainnet, and every Sui call goes through
[Tatum](https://tatum.io)'s gRPC gateway.

- **The app, its Tatum calls, its memory design and its exit:** [apps/kitty/README.md](apps/kitty/README.md)
- **The Move package:** [packages/move/kitty](packages/move/kitty), on testnet at `0xcd3889825bd9c444b4ef1b9846d84777784292546e83bec3c883ae89ff30d056`
- **Decisions:** [docs/adr](docs/adr/README.md)

## Run it locally
Needs Bun 1.3.14, Node 24, Docker, and the Sui CLI for Move tests.
```bash
cp .env.example .env              # fill in the Walrus Memory, Tatum and sponsor values; never commit it
docker compose up -d              # Postgres on localhost:5436
npx -y bun@1.3.14 install
bun run db:push                   # the app's own `kitty` schema
bun run dev                       # the API on http://localhost:8821
bun run dev:web                   # the web on http://localhost:5182 (/api → 8821)
```
`bun run build` writes `apps/kitty/web/dist`, and the API then serves the web itself on 8821.
The app README has the worker, the bot and the end-to-end run.

## Layout
| Path | What |
|---|---|
| `apps/kitty` | API, worker, Telegram bot (optional) and the React web (`web/`), Playwright e2e (`e2e/`) |
| `packages/move/kitty` | The Move package (`sui move test`) |
| `packages/chain` | `@total-recall/chain`: the Tatum gRPC client (paced, retried, usage counted) |
| `packages/memory` | `@total-recall/memory`: the Walrus Memory client (scopes, write policy, recall) |

## Checks
```bash
bun run lint && bun run typecheck && bun run test && bun run build
(cd packages/move/kitty && sui move test)
```
CI runs the same on every push.

## Origin
Split on Oct 25, 2026 out of our Remora monorepo (Track 2), at commit `7b3a66e`
([ADR-0065](docs/adr/0065-split-receipts-and-kitty-repos.md)). `packages/chain` and `packages/memory` are
copies of Remora's packages, which were ported from hippo, our earlier Walrus Memory chatbot (disclosed
prior work).

## License
[MIT](LICENSE) ([ADR-0068](docs/adr/0068-mit-license.md)). The parts copied from Remora are under the same terms.
