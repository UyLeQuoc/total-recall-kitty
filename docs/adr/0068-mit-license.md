# ADR-0068: MIT license

- **Status:** Accepted
- **Date:** 2026-10-25
- **Deciders:** Uy

## Context
- This repo has been public without a `LICENSE` since the split
  ([ADR-0065](0065-split-receipts-and-kitty-repos.md)). Without one, all rights are reserved and nobody
  may reuse the code.
- On Oct 25, Uy chose MIT for Remora, Receipts and Kitty together (Remora's ADR-0068).
- Much of the code was copied from Remora: `packages/chain`, `packages/memory`, and the web kit and
  tokens (ADR-0066).

## Decision
- **Kitty is MIT.** `LICENSE` at the root reads "Copyright (c) 2026 Uy Le and the Remora contributors".
- The copies from Remora are under the same terms. The web kit's components come from shadcn/ui,
  which is also MIT.
- **MIT, not Apache-2.0:** it's shorter, and someone copying one piece needs only the notice.

## Consequences
- Anyone may reuse the code if they keep the notice. MIT gives no patent grant.
- ADR-0065's "no license yet" point is settled. Its status line points here.
- New third-party code that requires a notice gets a `THIRD_PARTY_NOTICES.md` in the same commit.

## Links
- [LICENSE](../../LICENSE)
- ADR-0065; Remora's ADR-0068
