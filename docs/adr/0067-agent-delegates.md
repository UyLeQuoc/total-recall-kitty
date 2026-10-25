# ADR-0067: Agents with a mandate: onchain delegates, an MCP server, and the repo's own sponsor

- **Status:** Accepted
- **Date:** 2026-10-25
- **Deciders:** Uy (goal U12)

## Context
Remora's ADR-0066 (goal U12) asks each of Uy's three apps to let a person's AI agent act for them through
MCP, under one rule:
- an agent acts only with a credential its owner gave it and can revoke;
- money moves only inside the onchain limits;
- anything above those limits comes back to the owner.

For Kitty, that means an agent can do the pot's chores for one member. It proposes the group's small
spends and approves them inside a cap the member set. It never touches rules, closing, or anything above
the cap.

Kitty's pot (`kitty::pot`, version 1, [ADR-0062](0062-kitty-pot-design.md)) counts approvals by
member. Its `Pot` struct can't gain fields in an upgrade.

## Decision
- **Move, version 2.** This is a compatible upgrade of `kitty::pot`, authorized by the `UpgradeCap` the
  spike owner key holds, on testnet only.
  - **Naming a delegate.** `set_delegate(agent, approve_cap)` and `revoke_delegate()` are called by the
    member. There is one delegate per member, stored in a dynamic field (`DelegateKey { member }`) on the
    pot. Leaving the pot drops the delegate.
  - **Proposing.** `propose_as_delegate(member, payee, amount, memo)` is a spend only.
    - Within the cap, it carries the member's approval, as a member's own proposal does.
    - Above the cap, it carries no approval and waits for the member.
  - **Approving.** `approve_as_delegate(member, id)` adds the member's approval to a spend.
    - It aborts `EOverDelegateCap` above the cap.
    - It aborts `EDelegateSpendOnly` for a rule change or a close.
    - It aborts `ENotDelegate` once the delegate is revoked or replaced, and `ENotMember` once the member
      has left.
  - **Executing.** `execute_as_delegate(member, id)` runs a spend that already has its quorum, like
    `execute`. In the PTB, it comes right after the approval that reaches the quorum.
  - **Events.** `DelegateSet`, `DelegateRevoked`, `DelegateProposed` and `DelegateApproved`. Approvals
    keep counting by member, so the quorum is unchanged.
  - **Versions.**
    - `VERSION` goes to 2. Kitty migrates every open pot right after the upgrade, and new pots start at
      version 2.
    - Calls target the upgraded package id, while types (`Pot<C>`, `KITTY`) keep the original id.
      `deployments.ts` records both.
- **Signing.** The agent signs through the same sponsored prepare/execute flow as a wallet
  ([ADR-0064](0064-receipts-kitty-web-with-wallets.md)), so the server never holds the agent's key.
  - The stdio MCP server holds `KITTY_AGENT_KEY` on the agent's side.
  - It signs only after it decodes the prepared bytes and checks them:
    - the sender is the agent;
    - the gas owner is Kitty's sponsor;
    - every command is a `pot::*_as_delegate` call on the pot it asked about.
  - A refusal is normally caught when the transaction is built (409, nothing sent).
  - `record_refusal` sends the transaction anyway, so the chain records the abort with a digest. The exit
    uses this to prove the cap holds.
- **MCP.**
  - **stdio:** `pot_status`, `why`, `norms`, `propose_spend` and `approve`.
  - **Remote:** Streamable HTTP at `/mcp`, with the read tools only.
    - The bearer token is created by a member from the pot page, with a wallet-signed message.
    - It's shown once and stored as its SHA-256.
    - It's bound to one pot, revocable, and rate-limited (60 calls a minute).
- **Labels.** An agent's proposals and approvals are labelled as the agent's ("Bao's agent"). Its reason
  is stored with the approval and written to the pot's `norms` memory.
- **Web.**
  - A "Your agent" card names, caps and revokes the delegate, and shows the `claude mcp add` lines.
  - Above an agent's cap, a proposal shows "needs you" to its member.
- **The reference agent** `agents/treasurer` uses the stdio server and an OpenRouter model
  (`LLM_MODEL`).
  - Its decisions are the model's outputs, and its reasons cite memory blobs it read.
  - A forced attempt above the cap, used only to show the chain refusing, is labelled as forced in the
    exit record.
- **The repo's own testnet sponsor.**
  - `SPONSOR_PRIVATE_KEY_TESTNET` in this repo's `.env` is now its own key,
    `0x6b6654f27bb393fa49236480d916edc6f8c6a3daa8d08027878736b399a0d275`.
  - It was funded with 1 SUI from the spike owner (`37B2RkJkMwjPEJhaeoUrcm7dqM6u9wwurpueHButVErd`).
  - With its own key, Kitty's transactions never race Remora's or Receipts' for a gas coin.

## Consequences
- **The cap is enforced by the chain.** An agent's mistakes or injected instructions can cost the pot at
  most the member's cap per spend, and only for spends the group would see.
- **Version 1 calls stop working.** Calls to the original package id abort on migrated pots
  (`EWrongVersion`), so stale clients fail loudly.
- **Two signing paths.** The MCP server's byte check is a second guard, next to the server building the
  transaction. A compromised server could still ask the agent to sign a different delegate call on the
  same pot, but never to move money above the cap.
- **No zkLogin agents yet.** An agent is an ordinary Ed25519 key.

## Links
- Remora's ADR-0066 and goal U12, [ADR-0062](0062-kitty-pot-design.md),
  [ADR-0064](0064-receipts-kitty-web-with-wallets.md)
