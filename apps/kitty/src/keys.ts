import { decodeSuiPrivateKey, type Keypair } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1";

/** A `suiprivkey…` from `.env`. The value is never logged. */
export function keypairFrom(raw: string | undefined, name: string): Keypair {
  if (!raw) throw new Error(`${name} is not set`);
  const { scheme, secretKey } = decodeSuiPrivateKey(raw);
  return scheme === "Secp256k1"
    ? Secp256k1Keypair.fromSecretKey(secretKey)
    : Ed25519Keypair.fromSecretKey(secretKey);
}
