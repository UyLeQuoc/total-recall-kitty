/**
 * The on-chain verification path, tested against mainnet.
 *
 * This is the check that decides whether a person becomes owned-mode, and a
 * security review found the surrounding code trusting a request body instead of
 * the chain. It deserves a test that reads the real account rather than a mock,
 * because the whole point is that the chain is the authority.
 *
 * Skipped when credentials are absent so a clone without a `.env` still passes.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createClient, guestScope } from "./client.ts";
import { loadEnv } from "./env.ts";
import { createSuiClient, isDelegateRegistered, readAccount } from "./registry.ts";

loadEnv();

const ACCOUNT = process.env.MEMWAL_ACCOUNT_ID;
const REGISTRY = process.env.MEMWAL_REGISTRY_ID;
const live = Boolean(ACCOUNT && REGISTRY && process.env.SUI_NETWORK !== "testnet");

/** Never registered anywhere. */
const ABSENT_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

describe.skipIf(!live)("on-chain account reads (mainnet)", () => {
  let client: ReturnType<typeof createSuiClient>;
  let configuredKey = "";

  beforeAll(async () => {
    client = createSuiClient("mainnet");
    const memwal = createClient(
      guestScope(
        {
          key: process.env.MEMWAL_PRIVATE_KEY ?? "",
          accountId: ACCOUNT ?? "",
          serverUrl: process.env.MEMWAL_SERVER_URL ?? "https://relayer.memory.walrus.xyz",
        },
        "registry-test",
      ),
    );
    configuredKey = await memwal.getPublicKeyHex();
  });

  it("reads the account, its owner and its delegates", async () => {
    const account = await readAccount(client, ACCOUNT as string);
    expect(account).not.toBeNull();
    expect(account?.owner).toMatch(/^0x[0-9a-f]{64}$/);
    expect(account?.active).toBe(true);
    expect(account?.delegates.length).toBeGreaterThan(0);
    for (const d of account?.delegates ?? []) {
      // gRPC hands back base64; a caller comparing hex must get hex.
      expect(d.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
      expect(d.suiAddress).toMatch(/^0x[0-9a-f]{64}$/);
    }
  }, 30_000);

  it("confirms a key that is on chain", async () => {
    expect(await isDelegateRegistered(client, ACCOUNT as string, configuredKey)).toBe(true);
  }, 30_000);

  it("refuses a key that is not on chain, which is what gates owned mode", async () => {
    expect(await isDelegateRegistered(client, ACCOUNT as string, ABSENT_KEY)).toBe(false);
  }, 30_000);

  it("tolerates a 0x prefix and upper case on the key", async () => {
    expect(
      await isDelegateRegistered(client, ACCOUNT as string, `0x${configuredKey.toUpperCase()}`),
    ).toBe(true);
  }, 30_000);

  it("returns null for a real object of the wrong type", async () => {
    // The registry exists and is shared, but it is not a MemWalAccount. The
    // connect callback reads the user's wallet off this object's owner, so
    // accepting the wrong type would let a caller nominate someone else's
    // address. See docs/evidence/security-review-2026-09-21.md.
    expect(await readAccount(client, REGISTRY as string)).toBeNull();
    expect(await isDelegateRegistered(client, REGISTRY as string, configuredKey)).toBe(false);
  }, 30_000);

  it("returns null for an object that does not exist", async () => {
    const missing = `0x${"ab".repeat(32)}`;
    expect(await readAccount(client, missing)).toBeNull();
  }, 30_000);
});
