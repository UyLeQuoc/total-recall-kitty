/**
 * Wallet signature verification.
 *
 * Lives here rather than in the server because `@mysten/sui` is this package's
 * peer dependency, and because the rule it enforces is a memory-layer rule: an
 * address is only ever derived from a signature, never taken from a caller.
 */
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";

/** The message a wallet is asked to sign. Readable, so a signer sees the intent. */
export function signInMessage(nonce: string): string {
  return [
    "Sign in to Remora.",
    "",
    "This proves you control this wallet. It authorises nothing else: no",
    "transaction, no spending, no access to your funds.",
    "",
    `Nonce: ${nonce}`,
  ].join("\n");
}

/**
 * Recover the signer's address from a signature over `message`.
 * Returns null when the signature does not verify, rather than throwing, so a
 * caller cannot accidentally treat a failure as a pass.
 *
 * `client` is required for Slush. Those accounts are zkLogin, and the SDK
 * refuses to check that signature unless a fullnode is there to do it. Without
 * one, every Slush approval came back as "does not match".
 */
export async function addressFromSignature(
  message: string,
  signature: string,
  client?: ClientWithCoreApi,
): Promise<string | null> {
  try {
    const publicKey = await verifyPersonalMessageSignature(
      new TextEncoder().encode(message),
      signature,
      { client },
    );
    return publicKey.toSuiAddress().toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Sign a message with a throwaway keypair. For probes and tests only: it
 * creates a wallet that owns nothing, so a real signer is never needed to
 * exercise the sign-in flow.
 */
export async function signWithThrowawayWallet(
  message: string,
): Promise<{ address: string; signature: string }> {
  const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");
  const keypair = new Ed25519Keypair();
  const { signature } = await keypair.signPersonalMessage(new TextEncoder().encode(message));
  return { address: keypair.getPublicKey().toSuiAddress().toLowerCase(), signature };
}
