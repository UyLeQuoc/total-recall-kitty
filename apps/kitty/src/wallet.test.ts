/**
 * The wallet's side of a sponsored transaction (ADR-0064), without a network: a fake chain stands in
 * for Sui, and an Ed25519 key stands in for the member's wallet.
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { TransactionDataBuilder } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";
import { isValidTransactionSignature } from "@mysten/sui/verify";
import { describe, expect, it } from "vitest";
import { type ActionDeps, ActionError, depositCoins } from "./actions.ts";
import { createApp } from "./app.ts";
import { ChainAbort, type KittyChain, type Signer } from "./chain.ts";
import { createWalletSessions, WalletSessionError } from "./wallet.ts";

const USDC = "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC";

/** Builds "bytes" from what the action asked for, then signs and checks them like `createChain` does. */
function fakeChain(o: { abort?: string; coins?: string[] } = {}) {
  const built: string[] = [];
  const chain = {
    packageId: "0x1",
    typeOrigin: "0x1",
    coinType: USDC,
    sponsor: "0x5",
    client: {
      core: {
        async listCoins() {
          return {
            objects: (o.coins ?? []).map((objectId) => ({ objectId })),
            hasNextPage: false,
            cursor: null,
          };
        },
      },
    } as never,
    async run(signer: Signer) {
      if (o.abort) throw new ChainAbort(null, `MoveAbort in pot::execute: '${o.abort}'`);
      const bytes = new TextEncoder().encode(`tx ${built.length} from ${signer.toSuiAddress()}`);
      const { signature } = await signer.signTransaction(bytes);
      const ok = await isValidTransactionSignature(bytes, signature, {
        address: signer.toSuiAddress(),
      });
      if (!ok) throw new Error("bad signature");
      const digest = TransactionDataBuilder.getDigestFromBytes(bytes);
      built.push(digest);
      return { digest, success: true, error: null, created: [], events: [] };
    },
    async usdcAddressBalance() {
      return 0n;
    },
  } satisfies KittyChain;
  return { chain, built };
}

const deps = (chain: KittyChain): ActionDeps => ({
  db: {} as never,
  chain,
  memory: null,
  keys: new Map(),
});

describe("wallet sessions", () => {
  it("hands back the bytes to sign, then finishes the action with the wallet's signature", async () => {
    const wallet = Ed25519Keypair.generate();
    const sessions = createWalletSessions();
    const { chain, built } = fakeChain({ coins: ["0xc1", "0xc2"] });
    const prepared = await sessions.start(wallet.toSuiAddress(), (signer) =>
      depositCoins({ ...deps(chain), signer }, wallet.toSuiAddress()),
    );
    expect(prepared.sender).toBe(wallet.toSuiAddress());
    expect(sessions.size).toBe(1);
    const { signature } = await wallet.signTransaction(fromBase64(prepared.bytes));
    const result = await sessions.finish(prepared.digest, signature, prepared.bytes);
    expect(result).toEqual({ digest: prepared.digest, coins: 2 });
    expect(built).toEqual([prepared.digest]);
    expect(sessions.size).toBe(0);
  });

  it("refuses another key's signature, and different bytes from the ones built", async () => {
    const wallet = Ed25519Keypair.generate();
    const sessions = createWalletSessions();
    const { chain, built } = fakeChain({ coins: ["0xc1"] });
    const prepared = await sessions.start(wallet.toSuiAddress(), (signer) =>
      depositCoins({ ...deps(chain), signer }, wallet.toSuiAddress()),
    );
    await expect(
      sessions.finish(prepared.digest, "AAAA", Buffer.from("other").toString("base64")),
    ).rejects.toMatchObject({ code: "wrong_bytes" });
    const other = await Ed25519Keypair.generate().signTransaction(fromBase64(prepared.bytes));
    await expect(sessions.finish(prepared.digest, other.signature)).rejects.toThrow(
      "bad signature",
    );
    expect(built).toEqual([]);
  });

  it("answers an abort before any signature is asked for", async () => {
    const sessions = createWalletSessions();
    const { chain } = fakeChain({ abort: "EUnderQuorum", coins: ["0xc1"] });
    const err = await sessions
      .start("0x2", (signer) => depositCoins({ ...deps(chain), signer }, "0x2"))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChainAbort);
    expect((err as ChainAbort).code).toBe("EUnderQuorum");
    expect(sessions.size).toBe(0);
  });

  it("expires an unsigned transaction, and nothing is sent", async () => {
    const sessions = createWalletSessions({ ttlMs: 20 });
    const { chain, built } = fakeChain({ coins: ["0xc1"] });
    let ended: unknown = null;
    const prepared = await sessions.start("0x2", (signer) =>
      depositCoins({ ...deps(chain), signer }, "0x2").catch((e: unknown) => {
        ended = e;
        throw e;
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(ended).toBeInstanceOf(WalletSessionError);
    await expect(sessions.finish(prepared.digest, "sig")).rejects.toMatchObject({
      code: "expired",
    });
    expect(built).toEqual([]);
  });

  it("lets a wallet sign only for its own address", async () => {
    const { chain } = fakeChain({ coins: ["0xc1"] });
    const wallet = Ed25519Keypair.generate();
    await expect(
      depositCoins({ ...deps(chain), signer: wallet }, Ed25519Keypair.generate().toSuiAddress()),
    ).rejects.toBeInstanceOf(ActionError);
  });
});

describe("the API", () => {
  const post = (app: ReturnType<typeof createApp>, path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });

  it("prepares, then executes once the wallet has signed", async () => {
    const wallet = Ed25519Keypair.generate();
    const { chain } = fakeChain({ coins: ["0xc1"] });
    const app = createApp({ ...deps(chain), keeper: "0x9" });
    const prep = await post(app, "/api/tx/prepare", {
      action: "deposit",
      sender: wallet.toSuiAddress(),
    });
    expect(prep.status).toBe(200);
    const { bytes, digest } = (await prep.json()) as { bytes: string; digest: string };
    const { signature } = await wallet.signTransaction(fromBase64(bytes));
    const exec = await post(app, "/api/tx/execute", { digest, signature, bytes });
    expect(exec.status).toBe(200);
    expect(await exec.json()).toEqual({ digest, coins: 1 });
    const again = await post(app, "/api/tx/execute", { digest, signature, bytes });
    expect(again.status).toBe(409);
  });

  it("names the abort in the contract's words, with no signature asked for", async () => {
    const { chain } = fakeChain({ abort: "EOverAutoCap", coins: ["0xc1"] });
    const app = createApp({ ...deps(chain), keeper: "0x9" });
    const res = await post(app, "/api/tx/prepare", { action: "deposit", sender: "0x2" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "aborted",
      code: "EOverAutoCap",
      message: "Above the auto-ok cap: propose it and get the group's approvals.",
    });
  });

  it("rejects a malformed request", async () => {
    const { chain } = fakeChain();
    const app = createApp({ ...deps(chain), keeper: "0x9" });
    expect((await post(app, "/api/tx/prepare", { action: "join", sender: "nope" })).status).toBe(
      400,
    );
    expect((await app.request("/")).status).toBe(200);
  });
});
