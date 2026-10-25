# Kitty's exits on testnet

Money and Move run on Sui testnet. Memory is the operator's Walrus Memory account on the mainnet relayer.
The members are generated test keys, labelled "(test)" everywhere, and no payday or approval is a real
person's.

## Packages
| | Id | Digest |
|---|---|---|
| `kitty::pot` v1, published Oct 24 | `0xcd3889825bd9c444b4ef1b9846d84777784292546e83bec3c883ae89ff30d056` (original id: types) | `CC51MbvM1aM5MY6hqo3sqFw4kNTQpqegpCnc7DmkWvhJ` |
| `kitty::pot` v2, upgraded Oct 25 (delegates, [ADR-0067](adr/0067-agent-delegates.md)) | `0x0440fb4b853512775c229ad0b991c5242c4e6320a7a0cc41387362d76d7bdd88` (calls) | `mKv4cTNdhdBWTxD9aKLcLek84qiQyXWa98FDQN3zxi4` |
| Open pots migrated to v2 | 2 pots | `F7LZop13qtPH4gLTM8cHSB1KR1vwEpQY9f4azS3u1Bmf` |

The spike owner key holds the `UpgradeCap` (`0xe1abca059baa4954993dbd57ce1fafa74a2d2b4257cb26572bc2302a2435d3aa`).

## U11 exit (Oct 24, in the Remora monorepo)
"Da Lat trip (test)", pot `0x7f50c227d023dee8b6d42ad4e6a53457b17f78cbbe994bf3ab02c50d4c6ff651`:
- goal $1.50 in 3 h, a 1-hour window, quorum 2;
- Ava, Bao and Chi (test), each capped at $0.40 per window;
- every transaction sponsored.

| # | Check | Result |
|---|---|---|
| 0 | The spike owner's USDC coins move into its address balance; the members are funded (A $1, B $1, C $0.05) | ✅ `9XTvStTi…`, `4aunLYZQ…` |
| 1 | The pot is created; three joins, one signature each | ✅ `6jSJkdQs…`; joins `AYQLQtVV…`, `7g1LFfwz…`, `2sWV28VG…` |
| 2 | Two pulls land ($0.29, then $0.26) | ✅ `C7M2s9S6…`, `GLEDCDsS…` |
| 2 | Chi is short: no transaction, a memory | ✅ "SKIP … balance $0.05 < share $0.23, so no transaction and no fee" |
| 2 | Payday: the spike owner pays Chi $0.50, and the filtered stream sees it | ✅ `C9w6ggoD…`, checkpoint 398734508 |
| 2 | Chi is pulled right after payday, and the pull cites the memory | ✅ `4pUfpuZJ…`, memory `IgDkR0N8yMHcGG2pCIcBgOYWQSMmNnC8KbVBsdnM1fQ` |
| 3 | A pull above the window's cap aborts onchain, and nothing moves | ✅ `BKvY9QZGie6ut8m2HzUhkMMCtZmJoWsTxJY2NiuQdyUd`: `EExceedsRateLimit` |
| 4 | A spend below quorum aborts | ✅ `9HvfzX1rWqNacxfNGP5vv6VTVFdbUoaJeESUhXrzzZNh`: `EUnderQuorum` |
| 4 | With a second approval, "hotel" executes and pays $0.20 | ✅ `C8A38vD9BZzXiYSdnPWdc1xCatGBgFetsJurfJcV85h3` |
| 5 | Three quick food spends → Kitty suggests auto-ok up to $0.05; the group votes it in | ✅ `C8N3saA7…`, `auto_ok_cap` = 50000 |
| 5 | A spend inside the cap passes, and one above it aborts | ✅ `5d8kacCL…`; ✅ `2jUQ4sVNthnPCHLBdp4obfEvyAjo12VxwAUcDDbuMR1B`: `EOverAutoCap` |
| 6 | Chi leaves: the allowance is revoked | ✅ `9Fm8uA6p…` |
| 6 | Close by vote: pro-rata refunds, the sums balance | ✅ `Fzqkv85h…`: in $0.78138 = spent $0.33 + refunded $0.45138 |
| 7 | ≥10 kitty memories on the mainnet relayer | ✅ `members` 7 + `norms` 3 |

Steps 3 to 5 were re-run as committed failed transactions (`exit.ts overcap`, `exit.ts aborts`). The
SDK's build refuses to send a transaction that would abort, so the first run had no digest for them.

## The web with wallets (Oct 25, [ADR-0064](adr/0064-receipts-kitty-web-with-wallets.md))
Playwright drove an injected wallet-standard test wallet. Every member step was signed by the member's
own wallet, and the sponsor paid the gas.

| Step | Digest |
|---|---|
| Ava's wallet starts pot `0xab39…1f14` | `EESbNGcHYCrsnQS4Tc95aQwV4Vqhqo9urdZ7me1Q89kF` |
| Ava joins, Bao joins | `DyeZrsuhFj4bTzZwz99sGi7CLrmVzg3WAkwrn1QeSfJB`, `G7TfkpjEKWuqwywT91GpQd9Zdo3Af7Le5JWbCxG7V2P3` |
| The keeper pulls $0.10 from Ava | `922UL93Pmc13v8yXXDgm354spqcz3ifBfk6YpQzov65Y` |
| Ava proposes, and Bao's approval reaches quorum and pays | `89WTfQRcduCf61gzu2Jwyr2dUrqwsV11BuTkDBzqa2L7`, `2U2Z51QwDpw9eFLKwksP1xyZyfa4g6L1cgu6dzipDa6G` |
| Chi moves a USDC coin into his balance; Ava leaves | `CnkXimcbesHtCnTex8ryCqvuQ7D5VVLjuHdhvNtYWKMr`, `H2yf89E1B9jkXzhe9CCWpA4m7rshsN9YsWmA2Cojr57s` |

## U12 exit: an agent with a mandate (Oct 25, [ADR-0067](adr/0067-agent-delegates.md))
- **When:** 03:17–03:19 UTC, 2.3 min, one run, all steps passed the first time:
  `bunx playwright test -c e2e/playwright.config.ts agents.e2e.ts`.
- **Pot:** "Agent check 10-25 03:17 (test)", `0x85a83ed3c0939614dea0352100851144f7d208131a4eb4d6649f6373e2a71967`,
  quorum 2. Ava, Bao and Chi (test) each have a $0.40/hour cap.
- **The treasurer:** agent `0x994dd96528195d94d2d32295235a89e3bd06ebbc3b6d0215b8694c39fe09d213`. Its own key
  lives only in its stdio MCP server, and it decides with `google/gemini-2.5-flash` on OpenRouter.
- **Gas:** paid by this repo's own sponsor, `0x6b66…d275`.

| # | Step | Result |
|---|---|---|
| 1 | Pot created; Ava, Bao, Chi join (test keys); the keeper pulls $0.15 from Ava and Bao | ✅ `GZx3RZS2mREUYVeAuwN9hwx7hst9iG4zp2qqVLHnUxXe`; joins `DqqHncCg…`, `3heLk7xy…`, `6JdawUnC…`; pulls `ExuaUn3Z…`, `7jWAKBmt…` |
| 2 | **Bao names the treasurer with a $0.10 cap**, signed by Bao's wallet in the web | ✅ `qSQ7fHr6BvJBgG9QnvXtiedw9kerAcgoeoqGE1TCPHw`; memory `DELEGATE … up to $0.10 each`, blob `13qed0PWvcwKy15A3nCTn8LvCgcOk3DxRejsJCCR-6M` |
| 3 | Ava proposes $0.05 "food: snacks for the bus". **The treasurer approves it for Bao** (model decision), and it executes at quorum | ✅ `8M97wMSH83E6adFVBhXYy1BwsRdZSBoqvoqvKFKaHRbk`: approve + execute as delegate, Chi paid $0.05. Reason: "The spend is for snacks, which aligns with common group pot uses, is within the pot's balance, and within my approval cap for Bao." It cites blob `13qed0PW…` (the mandate) |
| 4a | Ava proposes $0.20 "hotel: deposit for two rooms". The treasurer's model decides | ✅ **declined**: "The proposed spend of $0.20 is above my approval cap of $0.10 for Bao. Bao must decide on this proposal." (cites `13qed0PW…`) |
| 4b | A **FORCED** approval through the agent's key (no model, `--record-refusal`) | ✅ aborts onchain: `BPzQ23yj3BT86Q2ca2pnC1gBLM7AgZHEns1jzuoQJHC7`, `EOverDelegateCap`, a committed failed transaction; memory `AGENT_REFUSED`, blob `W_X1oolI…` |
| 5 | The pot page shows Bao "needs you"; **Bao approves the hotel in the web**, and it's paid | ✅ `Cugk3HLta8Aa3Vmee6QdTzsUddELJaW3a3mEQAmhFFZT` |
| 6 | **Bao revokes the agent in the web** | ✅ `52od7KRSZEM5taReoXyc6imTw1G4MqcyYYEC8Yt69D2y`; memory `UNDELEGATE …` |
| 7 | Ava proposes $0.03 "food: water"; a FORCED approval through the agent's key | ✅ aborts onchain: `2Zunur5q2Hjpub7ucxTeupGGtDKkq7QudeCqz2pry7AU`, `ENotDelegate` |
| 8 | Memories in `kitty:pot:<id>:norms` | ✅ `DELEGATE`, `AGENT_APPROVED` (`CNXA0XZn…`), `APPROVED` ×2, `AGENT_REFUSED` ×2 and `UNDELEGATE`. The last two were still `accepted` when the run ended |

- **Timings (s):** setup 37, delegate 33 (most of it waiting for the mandate's blob), agent approval 9.8,
  over-cap 21, member approval 3.3, revoke and refusal 27.
- **Money:** in $0.30, spent $0.25 (food $0.05, hotel $0.20), $0.05 left in the pot.
- **Screenshots:** `apps/kitty/test-results/u12/pot-agent-{1280,375}-{light,dark}.png` (gitignored). They
  were re-taken after a 375 px fix, so they show the pot after the revoke: the "Your agent" form, and #0
  "approved by Ava, Bao's agent" with the agent's reason.

**What isn't verified:**
- a real wallet app (Slush) signing the delegate transactions; only the injected test wallet did;
- Claude Code itself as the MCP client. The treasurer's own MCP client ran the stdio server; the remote
  `/mcp` endpoint and its tokens are covered by unit and DB tests, not by a live client.
