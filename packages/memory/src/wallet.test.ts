import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { describe, expect, it } from "vitest";
import { addressFromSignature, signInMessage } from "./wallet.ts";

describe("wallet signature verification", () => {
  it("recovers the signer's address", async () => {
    const kp = new Ed25519Keypair();
    const message = signInMessage("a".repeat(64));
    const { signature } = await kp.signPersonalMessage(new TextEncoder().encode(message));
    expect(await addressFromSignature(message, signature)).toBe(
      kp.getPublicKey().toSuiAddress().toLowerCase(),
    );
  });

  it("refuses a signature over a different nonce", async () => {
    // The whole point: a signature is bound to the exact message, so a
    // signature harvested elsewhere cannot be replayed against our challenge.
    const kp = new Ed25519Keypair();
    const signed = signInMessage("a".repeat(64));
    const { signature } = await kp.signPersonalMessage(new TextEncoder().encode(signed));
    expect(await addressFromSignature(signInMessage("b".repeat(64)), signature)).toBeNull();
  });

  it("returns null rather than throwing on garbage", async () => {
    const message = signInMessage("c".repeat(64));
    expect(await addressFromSignature(message, "not-a-signature")).toBeNull();
    expect(await addressFromSignature(message, "")).toBeNull();
  });

  it("never reports one signer's address for another's signature", async () => {
    const a = new Ed25519Keypair();
    const b = new Ed25519Keypair();
    const message = signInMessage("d".repeat(64));
    const { signature } = await a.signPersonalMessage(new TextEncoder().encode(message));
    const recovered = await addressFromSignature(message, signature);
    expect(recovered).not.toBe(b.getPublicKey().toSuiAddress().toLowerCase());
  });

  it("puts the nonce in the message so a signer can see what they are signing", () => {
    const nonce = "e".repeat(64);
    const message = signInMessage(nonce);
    expect(message).toContain(nonce);
    expect(message).toContain("authorises nothing else");
  });
});
