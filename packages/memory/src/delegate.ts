/**
 * Delegate keypairs for owned mode. The `/account` SDK entry needs @mysten/sui
 * as a peer dependency, so it is wrapped here rather than imported from apps.
 */
import { generateDelegateKey } from "@mysten-incubation/memwal/account";

export interface GeneratedDelegate {
  /** 64-hex Ed25519 seed. Encrypt before storing; never log or transmit. */
  privateKeyHex: string;
  /** 64-hex public key. Safe to send to the browser; registered on-chain. */
  publicKeyHex: string;
  /** Sui address the contract derives from the public key. */
  suiAddress: string;
}

export async function generateDelegate(): Promise<GeneratedDelegate> {
  const d = await generateDelegateKey();
  return {
    privateKeyHex: d.privateKey,
    publicKeyHex: Buffer.from(d.publicKey).toString("hex"),
    suiAddress: d.suiAddress,
  };
}
