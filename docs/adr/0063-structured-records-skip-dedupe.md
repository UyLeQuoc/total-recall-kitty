# ADR-0063: Receipts and Kitty write structured records without the semantic duplicate check

- **Status:** Accepted
- **Date:** 2026-10-24
- **Deciders:** Uy's agent (U11, unattended; Uy reviews in the morning)

## Context
`@remora/memory` checks every write against recall first. Anything within distance 0.25 counts as
"already known" and isn't written. That suits Remora's facts, where a restated preference is a repeat.

Kitty's exit on Oct 24 showed it doesn't suit structured records. These were all discarded:
- `JOINED member=0xb… (Bao) cap=$0.40 …` and Chi's join (Ava's was written);
- two of three `APPROVED proposal=N category=food …`;
- the `SUGGEST …` and the `PULLED … right after Chi's payday` records.

Their text differs only by an address, a number or a name, so they sit within the duplicate distance.
Each one is a distinct event the product cites. The check also spends one recall per write against the
relayer budget the two apps share with Remora.

## Decision
- `rememberWithDedupe` and `createMemoryPort` take `dedupe?: boolean`, default `true`. Remora's behaviour
  is unchanged.
- Receipts and Kitty pass `dedupe: false`. Their records are events with ids, and the apps already avoid
  real repeats: a trust snapshot is written only when the resolved count changes, an insight only when
  its `n` changes, and a suggestion only when its text is new.

## Consequences
- Every join, approval and pull is a memory the app can cite, and each write costs one request less.
- A bug that writes the same event twice would now store it twice. The apps' own checks above are the
  guard.
- A test in `packages/memory` covers it: a near-identical record is written, with no recall.

## Links
- ADR-0060, ADR-0061, ADR-0062; tech-reference §1.11 (dedupe distances)
